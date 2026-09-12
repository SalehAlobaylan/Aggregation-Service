export interface ContentStageLeaseHeartbeatOptions {
  initialLeaseExpiresAt: string;
  heartbeat: () => Promise<{ lease_expires_at: string }>;
  intervalMs?: number;
  safetyMarginMs?: number;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onRenewalFailure?: (error: unknown, leaseExpiresAt: string) => void;
  onLeaseLost?: (error: Error) => void;
}

export interface ContentStageLeaseRenewal {
  name?: string;
  initialLeaseExpiresAt: string;
  heartbeat: () => Promise<{ lease_expires_at: string }>;
}

export interface ContentStageLeaseHeartbeatsOptions {
  leases: readonly ContentStageLeaseRenewal[];
  intervalMs?: number;
  safetyMarginMs?: number;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onRenewalFailure?: (error: unknown, leaseExpiresAt: string, name: string) => void;
  onLeaseLost?: (error: Error) => void;
}

export interface ContentStageLeaseHeartbeat {
  signal: AbortSignal;
  leaseExpiresAt: () => string;
  addLease: (lease: ContentStageLeaseRenewal) => void;
  removeLease: (name: string) => void;
  stop: () => Promise<void>;
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener(
      "abort",
      finish,
      { once: true },
    );
  });
}

// One loop owns all renewals. Awaiting each heartbeat prevents overlapping
// requests, and stop() wakes the interval immediately during worker cleanup.
export function startContentStageLeaseHeartbeat(
  options: ContentStageLeaseHeartbeatOptions,
): ContentStageLeaseHeartbeat {
	return startContentStageLeaseHeartbeats({
		leases: [{ initialLeaseExpiresAt: options.initialLeaseExpiresAt, heartbeat: options.heartbeat }],
		intervalMs: options.intervalMs,
		safetyMarginMs: options.safetyMarginMs,
		now: options.now,
		wait: options.wait,
		onRenewalFailure: options.onRenewalFailure ? (error, expiresAt) => options.onRenewalFailure?.(error, expiresAt) : undefined,
		onLeaseLost: options.onLeaseLost,
	});
}

// One serialized loop owns every parent lease. This is deliberately a single
// controller: separate intervals can renew one authority while another expires
// and can continue effects after the shared cancellation signal should have
// stopped the worker.
export function startContentStageLeaseHeartbeats(
  options: ContentStageLeaseHeartbeatsOptions,
): ContentStageLeaseHeartbeat {
  const intervalMs = options.intervalMs ?? 30_000;
  const safetyMarginMs = options.safetyMarginMs ?? 15_000;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultWait;
  const stopController = new AbortController();
  const leaseController = new AbortController();
  const expirations = options.leases.map((lease) => ({
    name: lease.name ?? "lease",
    heartbeat: lease.heartbeat,
    value: Date.parse(lease.initialLeaseExpiresAt),
  }));
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const loseLease = (error: Error) => {
    if (leaseController.signal.aborted) return;
    options.onLeaseLost?.(error);
    leaseController.abort(error);
  };

  if (expirations.length === 0 || expirations.some((lease) => !Number.isFinite(lease.value))) {
    loseLease(new Error("Content-stage claim has an invalid lease expiration"));
  }
  const minimumExpiration = () => Math.min(...expirations.map((lease) => lease.value));
  const armDeadline = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (stopController.signal.aborted || leaseController.signal.aborted) return;
    const delay = minimumExpiration() - safetyMarginMs - now();
    if (!Number.isFinite(delay)) return;
    deadlineTimer = setTimeout(() => loseLease(new Error("Lease safety deadline reached while renewal was unavailable")), Math.max(0, delay));
    deadlineTimer.unref();
  };
  armDeadline();

  const task = (async () => {
    while (!stopController.signal.aborted && !leaseController.signal.aborted) {
      await wait(intervalMs, stopController.signal);
      if (stopController.signal.aborted || leaseController.signal.aborted) return;
      try {
        // Await every renewal in order. A slow CMS call cannot overlap with a
        // second loop and stale completion cannot overwrite a newer expiry.
        for (const lease of expirations) {
          try {
            const response = await lease.heartbeat();
            const renewed = Date.parse(response.lease_expires_at);
            if (!Number.isFinite(renewed)) {
              throw new Error("CMS returned an invalid content-stage lease expiration");
            }
            lease.value = renewed;
          } catch (error) {
            options.onRenewalFailure?.(error, new Date(lease.value).toISOString(), lease.name);
          }
        }
        armDeadline();
      } catch (error) {
        options.onRenewalFailure?.(error, new Date(minimumExpiration()).toISOString(), "controller");
      }
      if (now() >= minimumExpiration() - safetyMarginMs) {
        loseLease(
          new Error(
            "Content-stage lease could not be renewed before the safety margin",
          ),
        );
      }
    }
  })();

  return {
    signal: leaseController.signal,
    leaseExpiresAt: () => expirations.length > 0 ? new Date(minimumExpiration()).toISOString() : "",
    addLease: (lease) => {
      const value = Date.parse(lease.initialLeaseExpiresAt);
      if (!Number.isFinite(value)) {
        loseLease(new Error(`Lease ${lease.name ?? "lease"} has an invalid expiration`));
        return;
      }
      const name = lease.name ?? "lease";
      const existing = expirations.find((candidate) => candidate.name === name);
      if (existing) {
        existing.heartbeat = lease.heartbeat;
        existing.value = value;
      } else {
        expirations.push({ name, heartbeat: lease.heartbeat, value });
      }
      armDeadline();
    },
    removeLease: (name) => {
      const index = expirations.findIndex((lease) => lease.name === name);
      if (index >= 0) expirations.splice(index, 1);
      armDeadline();
    },
    stop: async () => {
      stopController.abort();
      if (deadlineTimer) clearTimeout(deadlineTimer);
      await task;
    },
  };
}
