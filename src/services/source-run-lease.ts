import { cmsClient } from '../cms/client.js';
import type { SourceRunExecutionEnvelope } from '../contracts/source-runs.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface SourceRunLeaseHeartbeat {
  /** Throws before a subsequent effect/receipt when CMS rejected a renewal. */
  assertCurrent(): void;
  /** Stops all timers; executors must call this in a finally block. */
  stop(): void;
  /** The last CMS-confirmed lease expiry, for logs and diagnostics only. */
  expiresAt(): string;
}

export interface SourceRunLeaseHeartbeatOptions {
  intervalMs?: number;
  requestId?: string;
  // Injection keeps the ownership/failure contract unit-testable without an
  // HTTP server. Production always uses the CMS client above.
  renew?: (input: Parameters<typeof cmsClient.heartbeatSourceRunUnit>[0], requestId?: string) => Promise<{ executionLeaseExpiresAt: string }>;
}

// A source-run executor renews its exact CMS lease while doing a potentially
// long provider or ingest operation. Failure is sticky: it prevents later
// side effects and terminal receipts so CMS can move the started unit into
// verification instead of accepting evidence from a stale worker.
export function startSourceRunLeaseHeartbeat(envelope: SourceRunExecutionEnvelope, options: SourceRunLeaseHeartbeatOptions = {}): SourceRunLeaseHeartbeat {
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000) {
    throw new Error('source-run heartbeat interval must be between one and sixty seconds');
  }
  const renew = options.renew ?? cmsClient.heartbeatSourceRunUnit.bind(cmsClient);
  const input = {
    tenantId: envelope.tenantId,
    requestId: envelope.sourceRunRequestId,
    attemptId: envelope.sourceRunAttemptId,
    unitId: envelope.executionUnitId,
    unitJobId: envelope.unitJobId,
    attemptFenceToken: envelope.attemptFenceToken,
    executionLeaseToken: envelope.executionLeaseToken,
  };
  let stopped = false;
  let renewalFailure: Error | undefined;
  let confirmedExpiry = envelope.executionLeaseExpiresAt;
  let inFlight = false;

  const renewOnce = async (): Promise<void> => {
    if (stopped || inFlight || renewalFailure) return;
    inFlight = true;
    try {
      const result = await renew(input, options.requestId);
      confirmedExpiry = result.executionLeaseExpiresAt;
    } catch (error) {
      renewalFailure = error instanceof Error ? error : new Error('source-run lease renewal failed');
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => { void renewOnce(); }, intervalMs);
  timer.unref();
  // Renew once immediately: a queued job may begin close to its initial lease
  // expiry, and relying on the first interval would be an unsafe assumption.
  void renewOnce();

  return {
    assertCurrent() {
      if (renewalFailure) throw renewalFailure;
      if (Date.parse(confirmedExpiry) <= Date.now()) {
        throw new Error('source-run execution lease expired before the next effect boundary');
      }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    expiresAt() {
      return confirmedExpiry;
    },
  };
}
