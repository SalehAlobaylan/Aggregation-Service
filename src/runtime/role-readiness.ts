import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { cmsClient } from "../cms/client.js";
import { logger } from "../observability/logger.js";
import { getQueue, QUEUE_NAMES } from "../queues/index.js";
import { getRedisConnection, isRedisConnected } from "../queues/redis.js";
import {
  CORE_WORKER_ROLES,
  EXPLICIT_WORKER_ROLES,
  ROLE_TOPOLOGY_SCHEMA_VERSION,
  roleTopologyDigest,
  type WorkerRole,
} from "./role-topology.js";
import * as workerRuntime from "../workers/index.js";
import { getWorkerLiveness, mandatoryWorkersHealthy } from "../workers/worker-liveness.js";

export const ROLE_READINESS_SCHEMA_VERSION = "aggregation-role-readiness/v1";
export const AGGREGATE_READINESS_SCHEMA_VERSION = "aggregation-topology-readiness/v1";
const REGISTRY_PREFIX = "{wahb-aggregation-readiness}:v1";
const HEARTBEAT_INTERVAL_MS = 10_000;
const LEASE_TTL_MS = 35_000;
const FRESH_FOR_MS = 25_000;
const MAX_INSTANCES_PER_ROLE = 64;

const instanceId = createHash("sha256")
  .update(`${hostname()}:${process.pid}:${randomUUID()}`)
  .digest("hex")
  .slice(0, 32);
const startedAt = new Date().toISOString();
let leaseCurrent = false;
let publisherRole: WorkerRole | null = null;
let publisherTimer: NodeJS.Timeout | null = null;
let publishInFlight = false;
let publisherStopPromise: Promise<void> | null = null;

export interface LocalRoleReadiness {
  schema_version: typeof ROLE_READINESS_SCHEMA_VERSION;
  topology_schema_version: typeof ROLE_TOPOLOGY_SCHEMA_VERSION;
  topology_digest: string;
  instance_id: string;
  role: WorkerRole | null;
  started_at: string;
  heartbeat_at: string;
  pod_ready: boolean;
  owner_ready: boolean;
  registry_lease_current: boolean;
  draining: boolean;
  dependencies: {
    redis: "connected" | "disconnected";
    cms: "reachable" | "unreachable";
    workers: "healthy" | "stale" | "missing";
  };
  workers: ReturnType<typeof getWorkerLiveness>;
  worker_ownership: {
    expected: string[];
    registered: string[];
    missing: string[];
    unexpected: string[];
    required_queue_clients: string[];
    initialized_queue_clients: string[];
    missing_queue_clients: string[];
    unexpected_queue_clients: string[];
  };
  startup_hooks: {
    expected: string[];
    ready: string[];
    pending: string[];
    failed: Array<{ hook: string; error?: string }>;
  };
  reasons: string[];
}

export interface AggregateCapabilityReadiness {
  ready: boolean;
  required_roles: string[];
  reasons: string[];
}

export interface AggregateRoleReadiness {
  required: boolean;
  ready: boolean;
  healthy_instances: number;
  observed_instances: number;
  stale_instances: number;
  incompatible_instances: number;
  draining_instances: number;
  reasons: string[];
}

export interface AggregateTopologyReadiness {
  schema_version: typeof AGGREGATE_READINESS_SCHEMA_VERSION;
  topology_schema_version: typeof ROLE_TOPOLOGY_SCHEMA_VERSION;
  topology_digest: string;
  captured_at: string;
  status: "healthy" | "degraded";
  legacy_drain_required: boolean;
  roles: Record<string, AggregateRoleReadiness>;
  capabilities: Record<string, AggregateCapabilityReadiness>;
  reasons: string[];
}

function ownershipReasons(readiness: {
  role: WorkerRole | null;
  missingConsumers: string[];
  unexpectedConsumers: string[];
  missingQueueClients: string[];
  unexpectedQueueClients: string[];
}, workersHealthy: boolean): string[] {
  const reasons: string[] = [];
  if (!readiness.role) reasons.push("worker role is not registered");
  if (readiness.missingConsumers.length) reasons.push(`missing consumers: ${readiness.missingConsumers.join(",")}`);
  if (readiness.unexpectedConsumers.length) reasons.push(`unexpected consumers: ${readiness.unexpectedConsumers.join(",")}`);
  if (readiness.missingQueueClients.length) reasons.push(`missing queue clients: ${readiness.missingQueueClients.join(",")}`);
  if (readiness.unexpectedQueueClients.length) reasons.push(`unexpected queue clients: ${readiness.unexpectedQueueClients.join(",")}`);
  if (readiness.role && !workersHealthy) reasons.push("one or more expected workers lack a fresh heartbeat");
  return reasons;
}

export async function localRoleReadiness(options: { requireRegistryLease?: boolean; draining?: boolean; skipCmsProbe?: boolean } = {}): Promise<LocalRoleReadiness> {
  const ownership = workerRuntime.getWorkerOwnership();
  const workers = getWorkerLiveness();
	// Older unit harnesses may mock the worker module without this additive
	// diagnostic export. Treat that as an empty hook snapshot, which correctly
	// leaves readiness pending for roles whose hooks are not observable.
	let hookStates: ReturnType<typeof workerRuntime.getStartupHookReadiness> = [];
	try {
		const hookReader = (workerRuntime as Partial<typeof workerRuntime>).getStartupHookReadiness;
		if (typeof hookReader === "function") hookStates = hookReader();
	} catch {
		// Compatibility with older readiness test doubles; production always
		// exports the hook snapshot.
	}
	const expectedHooks = ownership.startupHooks ?? [];
	const readyHooks = hookStates.filter((state) => state.status === "ready").map((state) => state.hook);
	const readyHookSet = new Set<string>(readyHooks);
	const pendingHooks = expectedHooks.filter((hook) => !readyHookSet.has(hook) && !hookStates.some((state) => state.hook === hook && state.status === "failed"));
	const failedHooks = hookStates.filter((state) => state.status === "failed").map((state) => ({ hook: state.hook, error: state.error }));
	const hooksReady = expectedHooks.every((hook) => readyHookSet.has(hook));
  const exactOwnership = ownership.role !== null
    && ownership.missingConsumers.length === 0
    && ownership.unexpectedConsumers.length === 0
    && ownership.missingQueueClients.length === 0
    && ownership.unexpectedQueueClients.length === 0;
  const workersHealthy = exactOwnership && mandatoryWorkersHealthy(ownership.expectedConsumers);
  const redisConnected = await isRedisConnected();
  let cmsReachable = false;
  if (!options.skipCmsProbe) {
    try {
      cmsReachable = await cmsClient.ping();
    } catch {
      cmsReachable = false;
    }
  }
  // Keep the distributed owner proof independent of CMS-backed startup hooks.
  // Several hooks reconcile durable work by calling CMS endpoints whose claim
  // gates consume this proof; including them here creates a readiness cycle
  // where neither side can become ready. Hook health still participates in the
  // role-local pod verdict below.
  const ownerReady = redisConnected && workersHealthy && !options.draining;
  const requireRegistryLease = options.requireRegistryLease ?? true;
  const podReady = ownerReady && hooksReady && cmsReachable && (!requireRegistryLease || leaseCurrent);
  const reasons = ownershipReasons(ownership, workersHealthy);
  if (!redisConnected) reasons.push("Redis is disconnected");
  if (!cmsReachable) reasons.push("CMS is unreachable");
  if (requireRegistryLease && !leaseCurrent) reasons.push("distributed role lease is not current");
  if (options.draining) reasons.push("role is draining");
	if (pendingHooks.length) reasons.push(`startup hooks pending: ${pendingHooks.join(",")}`);
	if (failedHooks.length) reasons.push(`startup hooks failed: ${failedHooks.map((entry) => entry.hook).join(",")}`);
  return {
    schema_version: ROLE_READINESS_SCHEMA_VERSION,
    topology_schema_version: ROLE_TOPOLOGY_SCHEMA_VERSION,
    topology_digest: roleTopologyDigest(),
    instance_id: instanceId,
    role: ownership.role,
    started_at: startedAt,
    heartbeat_at: new Date().toISOString(),
    pod_ready: podReady,
    owner_ready: ownerReady,
    registry_lease_current: leaseCurrent,
    draining: options.draining ?? false,
    dependencies: {
      redis: redisConnected ? "connected" : "disconnected",
      cms: cmsReachable ? "reachable" : "unreachable",
      workers: !exactOwnership ? "missing" : workersHealthy ? "healthy" : "stale",
    },
    workers,
    worker_ownership: {
      expected: ownership.expectedConsumers,
      registered: ownership.registeredConsumers,
      missing: ownership.missingConsumers,
      unexpected: ownership.unexpectedConsumers,
      required_queue_clients: ownership.requiredQueueClients,
      initialized_queue_clients: ownership.initializedQueueClients,
      missing_queue_clients: ownership.missingQueueClients,
      unexpected_queue_clients: ownership.unexpectedQueueClients,
    },
	startup_hooks: { expected: expectedHooks, ready: readyHooks, pending: pendingHooks, failed: failedHooks },
    reasons,
  };
}

function membersKey(role: WorkerRole): string {
  return `${REGISTRY_PREFIX}:members:${role}`;
}

function leaseKey(role: WorkerRole, id: string): string {
  return `${REGISTRY_PREFIX}:lease:${role}:${id}`;
}

const publishLeaseScript = `
local members = KEYS[1]
local lease = KEYS[2]
local now = tonumber(ARGV[1])
local expires = tonumber(ARGV[2])
local instance = ARGV[3]
local payload = ARGV[4]
local lease_prefix = ARGV[5]
local maximum = tonumber(ARGV[6])
local expired = redis.call('ZRANGEBYSCORE', members, '-inf', now)
for _, member in ipairs(expired) do
  redis.call('DEL', lease_prefix .. member)
end
redis.call('ZREMRANGEBYSCORE', members, '-inf', now)
redis.call('ZADD', members, expires, instance)
redis.call('SET', lease, payload, 'PX', expires - now)
local count = redis.call('ZCARD', members)
if count > maximum then
  local overflow = redis.call('ZRANGE', members, 0, count - maximum - 1)
  for _, member in ipairs(overflow) do
    redis.call('ZREM', members, member)
    redis.call('DEL', lease_prefix .. member)
  end
end
redis.call('PEXPIRE', members, ${LEASE_TTL_MS * 4})
return redis.call('ZCARD', members)
`;

async function writeLease(role: WorkerRole, draining = false): Promise<void> {
  const now = Date.now();
  const payload = await localRoleReadiness({ requireRegistryLease: false, draining, skipCmsProbe: draining });
  const prefix = `${REGISTRY_PREFIX}:lease:${role}:`;
  await getRedisConnection().eval(
    publishLeaseScript,
    2,
    membersKey(role),
    leaseKey(role, instanceId),
    now,
    now + LEASE_TTL_MS,
    instanceId,
    JSON.stringify(payload),
    prefix,
    MAX_INSTANCES_PER_ROLE,
  );
  leaseCurrent = !draining;
}

async function removeLease(role: WorkerRole): Promise<void> {
  const redis = getRedisConnection();
  await redis.multi().zrem(membersKey(role), instanceId).del(leaseKey(role, instanceId)).exec();
  leaseCurrent = false;
}

async function heartbeatRole(): Promise<void> {
  if (!publisherRole || publishInFlight) return;
  publishInFlight = true;
  try {
    await writeLease(publisherRole);
  } catch (error) {
    leaseCurrent = false;
    logger.warn("Aggregation role readiness lease renewal failed", {
      role: publisherRole,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    publishInFlight = false;
  }
}

export async function startRoleReadinessPublisher(role: WorkerRole): Promise<void> {
  if (publisherStopPromise) throw new Error(`Readiness publisher is stopping; cannot start ${role}`);
  if (publisherRole) {
    if (publisherRole !== role) throw new Error(`Readiness publisher already owns ${publisherRole}; cannot start ${role}`);
    return;
  }
  publisherRole = role;
  try {
    await writeLease(role);
  } catch (error) {
    publisherRole = null;
    leaseCurrent = false;
    throw error;
  }
  publisherTimer = setInterval(() => void heartbeatRole(), HEARTBEAT_INTERVAL_MS);
  publisherTimer.unref();
}

export async function stopRoleReadinessPublisher(): Promise<void> {
  if (publisherStopPromise) return publisherStopPromise;
  const promise = (async () => {
    const role = publisherRole;
    publisherRole = null;
    if (publisherTimer) clearInterval(publisherTimer);
    publisherTimer = null;
    if (!role) {
      leaseCurrent = false;
      return;
    }
    try {
      // Draining evidence is written without a CMS round-trip so shutdown
      // cannot be delayed by the dependency that the root launcher stops first.
      await writeLease(role, true);
      await removeLease(role);
    } catch (error) {
      leaseCurrent = false;
      logger.warn("Aggregation role readiness lease cleanup failed", {
        role,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  publisherStopPromise = promise;
  try {
    await promise;
  } finally {
    if (publisherStopPromise === promise) publisherStopPromise = null;
  }
}

function validLease(value: unknown, expectedRole: WorkerRole): value is LocalRoleReadiness {
  if (!value || typeof value !== "object") return false;
  const lease = value as Partial<LocalRoleReadiness>;
  return lease.schema_version === ROLE_READINESS_SCHEMA_VERSION
    && lease.topology_schema_version === ROLE_TOPOLOGY_SCHEMA_VERSION
    && lease.role === expectedRole
    && typeof lease.instance_id === "string"
    && typeof lease.heartbeat_at === "string"
    && typeof lease.owner_ready === "boolean"
    && typeof lease.draining === "boolean";
}

async function readRoleLeases(role: WorkerRole, now: number): Promise<Array<{ lease: LocalRoleReadiness | null; stale: boolean; incompatible: boolean }>> {
  const redis = getRedisConnection();
  const members = await redis.zrangebyscore(membersKey(role), now + 1, "+inf", "LIMIT", 0, MAX_INSTANCES_PER_ROLE);
  if (!members.length) return [];
  const payloads = await redis.mget(...members.map((member) => leaseKey(role, member)));
  return payloads.map((payload) => {
    if (!payload) return { lease: null, stale: true, incompatible: false };
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!validLease(parsed, role)) return { lease: null, stale: false, incompatible: true };
      const heartbeat = Date.parse(parsed.heartbeat_at);
      return {
        lease: parsed,
        stale: !Number.isFinite(heartbeat) || now - heartbeat > FRESH_FOR_MS || heartbeat > now + 5_000,
        incompatible: parsed.topology_digest !== roleTopologyDigest(),
      };
    } catch {
      return { lease: null, stale: false, incompatible: true };
    }
  });
}

function capability(roles: Record<string, AggregateRoleReadiness>, requiredRoles: string[]): AggregateCapabilityReadiness {
  const missing = requiredRoles.filter((role) => !roles[role]?.ready);
  return {
    ready: missing.length === 0,
    required_roles: requiredRoles,
    reasons: missing.map((role) => `${role} is not owner-ready`),
  };
}

export async function aggregateTopologyReadiness(now = Date.now()): Promise<AggregateTopologyReadiness> {
  const digest = roleTopologyDigest();
  const allLeases = await Promise.all([...EXPLICIT_WORKER_ROLES, "all" as const].map(async (role) => [role, await readRoleLeases(role, now)] as const));
  const byRole = Object.fromEntries(allLeases) as Record<WorkerRole, Awaited<ReturnType<typeof readRoleLeases>>>;
  const compatibleAll = process.env.NODE_ENV !== "production" && (byRole.all ?? []).some(({ lease, stale, incompatible }) => Boolean(lease?.owner_ready && !lease.draining && !stale && !incompatible));
  const legacyQueue = getQueue(QUEUE_NAMES.AI);
  let legacyDrainRequired = true;
  if (legacyQueue) {
    const counts = await legacyQueue.getJobCounts("waiting", "active", "delayed", "prioritized");
    legacyDrainRequired = counts.waiting + counts.active + counts.delayed + counts.prioritized > 0;
  }
  const roles: Record<string, AggregateRoleReadiness> = {};
  for (const role of EXPLICIT_WORKER_ROLES) {
    const entries = byRole[role] ?? [];
    const healthy = entries.filter(({ lease, stale, incompatible }) => Boolean(lease?.owner_ready && !lease.draining && !stale && !incompatible)).length;
    const stale = entries.filter((entry) => entry.stale).length;
    const incompatible = entries.filter((entry) => entry.incompatible).length;
    const draining = entries.filter(({ lease }) => lease?.draining).length;
    const ready = healthy > 0 || compatibleAll;
    const required = CORE_WORKER_ROLES.includes(role as (typeof CORE_WORKER_ROLES)[number]) || (role === "legacy-drain" && legacyDrainRequired);
    const reasons: string[] = [];
    if (!ready) reasons.push(entries.length === 0 ? "no live instance lease" : "no compatible owner-ready instance");
    if (stale) reasons.push(`${stale} stale instance lease(s)`);
    if (incompatible) reasons.push(`${incompatible} incompatible instance lease(s)`);
    if (draining) reasons.push(`${draining} draining instance(s)`);
    roles[role] = {
      required,
      ready,
      healthy_instances: healthy + (compatibleAll ? 1 : 0),
      observed_instances: entries.length + (compatibleAll ? 1 : 0),
      stale_instances: stale,
      incompatible_instances: incompatible,
      draining_instances: draining,
      reasons,
    };
  }
  const capabilities: Record<string, AggregateCapabilityReadiness> = {
    aggregation_dispatcher: capability(roles, ["intake-control"]),
    aggregation_receipt: capability(roles, ["intake-control"]),
    aggregation_pipeline: capability(roles, ["media-maintenance"]),
    aggregation_atomization: capability(roles, ["media-executor"]),
    news_processing: capability(roles, ["news"]),
    pods_processing: capability(roles, ["pods-control"]),
    pods_media_execution: capability(roles, ["media-executor"]),
    legacy_drain: capability(roles, legacyDrainRequired ? ["legacy-drain"] : []),
  };
  const missingRequired = Object.entries(roles).filter(([, state]) => state.required && !state.ready).map(([role]) => role);
  return {
    schema_version: AGGREGATE_READINESS_SCHEMA_VERSION,
    topology_schema_version: ROLE_TOPOLOGY_SCHEMA_VERSION,
    topology_digest: digest,
    captured_at: new Date(now).toISOString(),
    status: missingRequired.length ? "degraded" : "healthy",
    legacy_drain_required: legacyDrainRequired,
    roles,
    capabilities,
    reasons: missingRequired.map((role) => `${role} has no compatible owner-ready instance`),
  };
}

export const roleReadinessTestUtils = {
  instanceId,
  setLeaseCurrent(current: boolean): void { leaseCurrent = current; },
  reset(): void {
    leaseCurrent = false;
    publisherRole = null;
    if (publisherTimer) clearInterval(publisherTimer);
    publisherTimer = null;
    publishInFlight = false;
    publisherStopPromise = null;
  },
  constants: { HEARTBEAT_INTERVAL_MS, LEASE_TTL_MS, FRESH_FOR_MS, MAX_INSTANCES_PER_ROLE },
};
