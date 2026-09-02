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

export interface ContentStageLeaseHeartbeat {
  signal: AbortSignal;
  leaseExpiresAt: () => string;
  stop: () => Promise<void>;
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// One loop owns all renewals. Awaiting each heartbeat prevents overlapping
// requests, and stop() wakes the interval immediately during worker cleanup.
export function startContentStageLeaseHeartbeat(
  options: ContentStageLeaseHeartbeatOptions,
): ContentStageLeaseHeartbeat {
  const intervalMs = options.intervalMs ?? 30_000;
  const safetyMarginMs = options.safetyMarginMs ?? 60_000;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultWait;
  const stopController = new AbortController();
  const leaseController = new AbortController();
  let leaseExpiresAt = Date.parse(options.initialLeaseExpiresAt);

  const loseLease = (error: Error) => {
    if (leaseController.signal.aborted) return;
    options.onLeaseLost?.(error);
    leaseController.abort(error);
  };

  if (!Number.isFinite(leaseExpiresAt)) {
    loseLease(new Error("Content-stage claim has an invalid lease expiration"));
  }

  const task = (async () => {
    while (!stopController.signal.aborted && !leaseController.signal.aborted) {
      await wait(intervalMs, stopController.signal);
      if (stopController.signal.aborted || leaseController.signal.aborted) return;
      try {
        const response = await options.heartbeat();
        const renewed = Date.parse(response.lease_expires_at);
        if (!Number.isFinite(renewed)) {
          throw new Error("CMS returned an invalid content-stage lease expiration");
        }
        leaseExpiresAt = renewed;
      } catch (error) {
        options.onRenewalFailure?.(
          error,
          new Date(leaseExpiresAt).toISOString(),
        );
      }
      if (now() >= leaseExpiresAt - safetyMarginMs) {
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
    leaseExpiresAt: () => new Date(leaseExpiresAt).toISOString(),
    stop: async () => {
      stopController.abort();
      await task;
    },
  };
}
