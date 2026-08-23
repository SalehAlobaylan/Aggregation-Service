/**
 * Redis-backed weighted admission for the physical compute domain.  BullMQ
 * controls delivery; this module controls whether an expensive effect may
 * begin.  A worker must release the lease only after its child has exited.
 */
import { randomUUID } from 'crypto';
import { getRedisConnection } from '../queues/redis.js';
import { mediaPermitSaturation, resourcePermits, resourceDeferrals } from '../observability/metrics.js';

export type WorkloadClass = 'software_encode' | 'hardware_encode' | 'light_media' | 'download_io' | 'maintenance_encode';
export type WorkloadLane = 'required' | 'maintenance';

const WEIGHT: Record<WorkloadClass, number> = {
    software_encode: 2,
    hardware_encode: 1,
    light_media: 1,
    download_io: 1,
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
        this.name = 'ResourceDeferredError';
    }
}

export interface ResourceLease {
    id: string;
    workload: WorkloadClass;
    release(): Promise<void>;
    heartbeat(): Promise<boolean>;
}

function domain(): string {
    // Infrastructure identity only; capacity/priority stay code policy.
    return process.env.RESOURCE_DOMAIN?.trim() || 'local';
}

function key(): string { return `wahb:resource:${domain()}:compute`; }

const ACQUIRE = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local weight = tonumber(ARGV[3])
local lease = ARGV[4]
local expires = tonumber(ARGV[5])
local lane = ARGV[6]
local required_waiting = tonumber(redis.call('HGET', key, 'required_waiting') or '0')
for member, expiry in pairs(redis.call('ZRANGE', key .. ':leases', 0, -1, 'WITHSCORES')) do
  if tonumber(expiry) <= now then redis.call('ZREM', key .. ':leases', member); redis.call('HDEL', key .. ':weights', member) end
end
local values = redis.call('HVALS', key .. ':weights')
local used = 0
for _, value in ipairs(values) do used = used + tonumber(value) end
if lane == 'maintenance' and required_waiting > 0 then return {0, used} end
if used + weight > capacity then return {0, used} end
redis.call('ZADD', key .. ':leases', expires, lease)
redis.call('HSET', key .. ':weights', lease, weight)
redis.call('EXPIRE', key, 120)
redis.call('EXPIRE', key .. ':leases', 120)
return {1, used + weight}
`;

const HEARTBEAT = `
if redis.call('ZSCORE', KEYS[1] .. ':leases', ARGV[1]) == false then return 0 end
redis.call('ZADD', KEYS[1] .. ':leases', ARGV[2], ARGV[1])
return 1
`;

const RELEASE = `
redis.call('ZREM', KEYS[1] .. ':leases', ARGV[1])
redis.call('HDEL', KEYS[1] .. ':weights', ARGV[1])
local used = 0
for _, value in ipairs(redis.call('HVALS', KEYS[1] .. ':weights')) do used = used + tonumber(value) end
return used
`;

export async function acquireResourceLease(workload: WorkloadClass, lane: WorkloadLane = 'required'): Promise<ResourceLease> {
    const redis = getRedisConnection();
    const id = `${process.pid}:${randomUUID()}`;
    const now = Date.now();
    const acquired = await redis.eval(ACQUIRE, 1, key(), now, DEFAULT_COMPUTE_CAPACITY, WEIGHT[workload], id, now + LEASE_MS, lane) as [number, number];
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
            const ok = await redis.eval(HEARTBEAT, 1, key(), id, Date.now() + LEASE_MS);
            return Number(ok) === 1;
        },
        async release(): Promise<void> {
            if (released) return;
            released = true;
            const remaining = Number(await redis.eval(RELEASE, 1, key(), id));
            mediaPermitSaturation.set(Math.min(1, Math.max(0, remaining) / DEFAULT_COMPUTE_CAPACITY));
            resourcePermits.labels(workload, lane).dec(WEIGHT[workload]);
        },
    };
}

export async function withResourceLease<T>(workload: WorkloadClass, lane: WorkloadLane, effect: () => Promise<T>): Promise<T> {
    const lease = await acquireResourceLease(workload, lane);
    const heartbeat = setInterval(() => void lease.heartbeat().catch(() => undefined), LEASE_MS / 3);
    heartbeat.unref();
    try {
        return await effect();
    } finally {
        clearInterval(heartbeat);
        await lease.release();
    }
}
