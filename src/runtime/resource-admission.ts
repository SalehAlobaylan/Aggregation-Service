/**
 * Redis-backed weighted admission for the physical compute domain.  BullMQ
 * controls delivery; this module controls whether an expensive effect may
 * begin.  A worker must release the lease only after its child has exited.
 */
import { randomUUID } from "crypto";
import { getRedisConnection } from "../queues/redis.js";
import {
  mediaPermitSaturation,
  resourcePermits,
  resourceDeferrals,
} from "../observability/metrics.js";

export type WorkloadClass =
  | "software_encode"
  | "hardware_encode"
  | "light_media"
  | "download_io"
  | "media_io_package"
  | "maintenance_encode";
export type WorkloadLane = "required" | "maintenance";

const WEIGHT: Record<WorkloadClass, number> = {
  software_encode: 2,
  hardware_encode: 1,
  light_media: 1,
  download_io: 1,
  // HLS packaging is predominantly temporary-storage, object I/O and
  // validation. It must be admitted independently from CPU encoders.
  media_io_package: 1,
  maintenance_encode: 2,
};

// Two two-thread encoders on a local eight-core host. Production roles get a
// separate domain, so this code default never artificially couples machines.
const DEFAULT_COMPUTE_CAPACITY = 4;
const LEASE_MS = 45_000;

export class ResourceDeferredError extends Error {
  readonly retryAfterSec = 30;
  constructor(readonly workload: WorkloadClass) {
    super(`resource capacity unavailable for ${workload}`);
    this.name = "ResourceDeferredError";
  }
}

export class ResourceLeaseLostError extends Error {
  constructor(readonly workload: WorkloadClass) {
    super(`resource lease lost while running ${workload}`);
    this.name = "ResourceLeaseLostError";
  }
}

export function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) { abort(signal); continue; }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

export interface ResourceLease {
  id: string;
  workload: WorkloadClass;
  release(): Promise<void>;
  heartbeat(): Promise<boolean>;
}

function domain(): string {
  // Infrastructure identity only; capacity/priority stay code policy.
  return process.env.RESOURCE_DOMAIN?.trim() || "local";
}

function key(): string {
  return `wahb:resource:${domain()}:compute`;
}

const ACQUIRE = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local weight = tonumber(ARGV[3])
local lease = ARGV[4]
local expires = tonumber(ARGV[5])
local lane = ARGV[6]
local waiter = ARGV[7]
local leases = redis.call('ZRANGE', key .. ':leases', 0, -1, 'WITHSCORES')
for index = 1, #leases, 2 do
  local member = leases[index]
  local expiry = tonumber(leases[index + 1])
  if expiry <= now then redis.call('ZREM', key .. ':leases', member); redis.call('HDEL', key .. ':weights', member) end
end
-- Recover from an older lease ZSET expiring before its weights hash. A weight
-- without a live lease is never capacity ownership and must not strand the
-- domain permanently.
for _, member in ipairs(redis.call('HKEYS', key .. ':weights')) do
  if redis.call('ZSCORE', key .. ':leases', member) == false then
    redis.call('HDEL', key .. ':weights', member)
  end
end
redis.call('ZREMRANGEBYSCORE', key .. ':waiters', '-inf', now)
if lane == 'required' then redis.call('ZADD', key .. ':waiters', expires, waiter) end
local required_waiting = redis.call('ZCARD', key .. ':waiters')
local values = redis.call('HVALS', key .. ':weights')
local used = 0
for _, value in ipairs(values) do used = used + tonumber(value) end
if lane == 'maintenance' and required_waiting > 0 then return {0, used} end
if used + weight > capacity then return {0, used} end
redis.call('ZREM', key .. ':waiters', waiter)
redis.call('ZADD', key .. ':leases', expires, lease)
redis.call('HSET', key .. ':weights', lease, weight)
redis.call('EXPIRE', key .. ':leases', 120)
redis.call('EXPIRE', key .. ':weights', 120)
redis.call('EXPIRE', key .. ':waiters', 120)
return {1, used + weight}
`;

const HEARTBEAT = `
if redis.call('ZSCORE', KEYS[1] .. ':leases', ARGV[1]) == false then return 0 end
if redis.call('HEXISTS', KEYS[1] .. ':weights', ARGV[1]) == 0 then return 0 end
redis.call('ZADD', KEYS[1] .. ':leases', ARGV[2], ARGV[1])
redis.call('EXPIRE', KEYS[1] .. ':leases', 120)
redis.call('EXPIRE', KEYS[1] .. ':weights', 120)
redis.call('EXPIRE', KEYS[1] .. ':waiters', 120)
return 1
`;

const RELEASE = `
redis.call('ZREM', KEYS[1] .. ':leases', ARGV[1])
redis.call('HDEL', KEYS[1] .. ':weights', ARGV[1])
local used = 0
for _, value in ipairs(redis.call('HVALS', KEYS[1] .. ':weights')) do used = used + tonumber(value) end
return used
`;

export async function acquireResourceLease(
  workload: WorkloadClass,
  lane: WorkloadLane = "required",
  requestId?: string,
): Promise<ResourceLease> {
  const redis = getRedisConnection();
  const id = `${process.pid}:${randomUUID()}`;
  const now = Date.now();
  const acquired = (await redis.eval(
    ACQUIRE,
    1,
    key(),
    now,
    DEFAULT_COMPUTE_CAPACITY,
    WEIGHT[workload],
    id,
    now + LEASE_MS,
    lane,
    // The lease UUID is the attempt identity. A caller/job id may be reused
    // across retries and must never collapse two required waiters into one
    // Redis ZSET member.
    `${requestId?.trim() || "request"}:${id}`,
  )) as [number, number];
  const used = Number(acquired[1] ?? 0);
  mediaPermitSaturation.set(Math.min(1, used / DEFAULT_COMPUTE_CAPACITY));
  if (acquired[0] !== 1) {
    resourceDeferrals.labels(workload, lane).inc();
    throw new ResourceDeferredError(workload);
  }
  resourcePermits.labels(workload, lane).inc(WEIGHT[workload]);
  let released = false;
  return {
    id,
    workload,
    async heartbeat(): Promise<boolean> {
      if (released) return false;
      const ok = await redis.eval(
        HEARTBEAT,
        1,
        key(),
        id,
        Date.now() + LEASE_MS,
      );
      return Number(ok) === 1;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const remaining = Number(await redis.eval(RELEASE, 1, key(), id));
      mediaPermitSaturation.set(
        Math.min(1, Math.max(0, remaining) / DEFAULT_COMPUTE_CAPACITY),
      );
      resourcePermits.labels(workload, lane).dec(WEIGHT[workload]);
    },
  };
}

export async function withResourceLease<T>(
  workload: WorkloadClass,
  lane: WorkloadLane,
  effect: (leaseSignal: AbortSignal) => Promise<T>,
  requestId?: string,
): Promise<T> {
  const lease = await acquireResourceLease(workload, lane, requestId);
  const leaseAbort = new AbortController();
  let lost: ResourceLeaseLostError | undefined;
  let rejectLoss: ((error: Error) => void) | undefined;
  const loss = new Promise<never>((_, reject) => { rejectLoss = reject; });
  const heartbeat = setInterval(
    () => void lease.heartbeat().then((ok) => {
      if (!ok && !lost) {
        lost = new ResourceLeaseLostError(workload);
        leaseAbort.abort(lost);
        rejectLoss?.(lost);
      }
    }).catch(() => {
      if (!lost) {
        lost = new ResourceLeaseLostError(workload);
        leaseAbort.abort(lost);
        rejectLoss?.(lost);
      }
    }),
    LEASE_MS / 3,
  );
  heartbeat.unref();
  // Keep a handle to the actual effect. If the lease disappears, the race
  // rejects immediately so BullMQ can defer the job, but the child process
  // still needs time to observe the abort and exit before the lease is
  // released. Releasing first would let a replacement job overlap the
  // terminating encoder and recreate the overload this admission layer is
  // meant to prevent.
  // A callback typed as Promise<T> can still throw before returning one. Wrap
  // that synchronous failure so the lease-cleanup path always runs and the
  // admission record cannot be stranded.
  let effectPromise: Promise<T>;
  try {
    effectPromise = Promise.resolve(effect(leaseAbort.signal));
  } catch (error) {
    effectPromise = Promise.reject(error);
  }
  try {
    return await Promise.race([effectPromise, loss]);
  } finally {
    clearInterval(heartbeat);
    if (lost) await effectPromise.catch(() => undefined);
    await lease.release();
  }
}
