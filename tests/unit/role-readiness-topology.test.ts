import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  leases: new Map<string, string[]>(),
  payloads: new Map<string, string>(),
  legacyDepth: 0,
  failWrites: false,
  expectedHooks: [] as string[],
  startupHookReadiness: [] as Array<{ hook: string; status: "pending" | "ready" | "failed"; attempts: number; error?: string; updated_at: string }>,
}));

vi.mock("../../src/queues/redis.js", () => ({
  getRedisConnection: () => ({
    zrangebyscore: vi.fn(async (key: string) => mocks.leases.get(key) ?? []),
    mget: vi.fn(async (...keys: string[]) => keys.map((key) => mocks.payloads.get(key) ?? null)),
    eval: vi.fn(async (_script: string, _keyCount: number, membersKey: string, leaseKey: string, _now: number, _expires: number, id: string, payload: string) => {
      if (mocks.failWrites) throw new Error("lease write failed");
      mocks.leases.set(membersKey, [...new Set([...(mocks.leases.get(membersKey) ?? []), id])]);
      mocks.payloads.set(leaseKey, payload);
      return mocks.leases.get(membersKey)?.length ?? 0;
    }),
    multi: () => {
      const operations: Array<() => void> = [];
      const chain = {
        zrem(key: string, id: string) { operations.push(() => mocks.leases.set(key, (mocks.leases.get(key) ?? []).filter((value) => value !== id))); return chain; },
        del(key: string) { operations.push(() => { mocks.payloads.delete(key); }); return chain; },
        async exec() { operations.forEach((operation) => operation()); return []; },
      };
      return chain;
    },
  }),
  isRedisConnected: vi.fn(async () => true),
}));
vi.mock("../../src/queues/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/queues/index.js")>("../../src/queues/index.js");
  return {
    ...actual,
    getQueue: () => ({ getJobCounts: vi.fn(async () => ({ waiting: mocks.legacyDepth, active: 0, delayed: 0, prioritized: 0 })) }),
  };
});
vi.mock("../../src/cms/client.js", () => ({ cmsClient: { ping: vi.fn(async () => true) } }));
vi.mock("../../src/observability/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../../src/workers/index.js", () => ({
  getWorkerOwnership: vi.fn(() => ({
    role: "intake-control",
    expectedConsumers: ["fetch-queue"],
    registeredConsumers: ["fetch-queue"],
    missingConsumers: [],
    unexpectedConsumers: [],
    requiredQueueClients: ["fetch-queue"],
    initializedQueueClients: ["fetch-queue"],
    missingQueueClients: [],
    unexpectedQueueClients: [],
    startupHooks: mocks.expectedHooks,
  })),
  getStartupHookReadiness: vi.fn(() => mocks.startupHookReadiness),
}));
vi.mock("../../src/workers/worker-liveness.js", () => ({ getWorkerLiveness: vi.fn(() => ({})), mandatoryWorkersHealthy: vi.fn(() => true) }));

import {
  aggregateTopologyReadiness,
  localRoleReadiness,
  ROLE_READINESS_SCHEMA_VERSION,
  roleReadinessTestUtils,
  startRoleReadinessPublisher,
  stopRoleReadinessPublisher,
} from "../../src/runtime/role-readiness.js";
import {
  EXPLICIT_WORKER_ROLES,
  ROLE_TOPOLOGY_SCHEMA_VERSION,
  roleTopologyDigest,
  type WorkerRole,
} from "../../src/runtime/role-topology.js";

const prefix = "{wahb-aggregation-readiness}:v1";

function addLease(role: WorkerRole, id: string, options: { ownerReady?: boolean; draining?: boolean; heartbeat?: string; digest?: string } = {}) {
  const membersKey = `${prefix}:members:${role}`;
  const leaseKey = `${prefix}:lease:${role}:${id}`;
  mocks.leases.set(membersKey, [...(mocks.leases.get(membersKey) ?? []), id]);
  mocks.payloads.set(leaseKey, JSON.stringify({
    schema_version: ROLE_READINESS_SCHEMA_VERSION,
    topology_schema_version: ROLE_TOPOLOGY_SCHEMA_VERSION,
    topology_digest: options.digest ?? roleTopologyDigest(),
    instance_id: id,
    role,
    started_at: "2026-08-29T00:00:00.000Z",
    heartbeat_at: options.heartbeat ?? "2026-08-29T00:00:10.000Z",
    pod_ready: true,
    owner_ready: options.ownerReady ?? true,
    registry_lease_current: true,
    draining: options.draining ?? false,
    dependencies: { redis: "connected", cms: "reachable", workers: "healthy" },
    workers: {},
    worker_ownership: {
      expected: [], registered: [], missing: [], unexpected: [], required_queue_clients: [],
      initialized_queue_clients: [], missing_queue_clients: [], unexpected_queue_clients: [],
    },
    reasons: [],
  }));
}

describe("distributed Aggregation role topology", () => {
  const now = Date.parse("2026-08-29T00:00:20.000Z");

  beforeEach(() => {
    mocks.leases.clear();
    mocks.payloads.clear();
    mocks.legacyDepth = 0;
    mocks.failWrites = false;
    mocks.expectedHooks = [];
    mocks.startupHookReadiness = [];
    roleReadinessTestUtils.reset();
    delete process.env.NODE_ENV;
  });

  it("is healthy with every core role and an empty optional legacy lane", async () => {
    for (const role of EXPLICIT_WORKER_ROLES.filter((candidate) => candidate !== "legacy-drain")) addLease(role, `${role}-1`);
    const topology = await aggregateTopologyReadiness(now);
    expect(topology.status).toBe("healthy");
    expect(topology.legacy_drain_required).toBe(false);
    expect(topology.roles["legacy-drain"]).toMatchObject({ required: false, ready: false });
  });

  it("degrades only capabilities owned by a missing role", async () => {
    for (const role of EXPLICIT_WORKER_ROLES.filter((candidate) => candidate !== "legacy-drain" && candidate !== "media-maintenance")) addLease(role, `${role}-1`);
    const topology = await aggregateTopologyReadiness(now);
    expect(topology.status).toBe("degraded");
    expect(topology.capabilities.aggregation_pipeline.ready).toBe(false);
    expect(topology.capabilities.aggregation_dispatcher.ready).toBe(true);
    expect(topology.capabilities.aggregation_atomization.ready).toBe(true);
  });

  it("accepts one healthy replica when another replica is stale", async () => {
    for (const role of EXPLICIT_WORKER_ROLES.filter((candidate) => candidate !== "legacy-drain")) addLease(role, `${role}-1`);
    addLease("media-executor", "media-stale", { heartbeat: "2026-08-28T23:59:00.000Z" });
    const topology = await aggregateTopologyReadiness(now);
    expect(topology.roles["media-executor"]).toMatchObject({ ready: true, healthy_instances: 1, stale_instances: 1 });
  });

  it("rejects incompatible topology leases", async () => {
    for (const role of EXPLICIT_WORKER_ROLES.filter((candidate) => candidate !== "legacy-drain")) addLease(role, `${role}-1`);
    mocks.leases.clear();
    addLease("media-executor", "old", { digest: "0".repeat(64) });
    const topology = await aggregateTopologyReadiness(now);
    expect(topology.roles["media-executor"]).toMatchObject({ ready: false, incompatible_instances: 1 });
  });

  it("requires Legacy Drain only while legacy work exists", async () => {
    mocks.legacyDepth = 2;
    for (const role of EXPLICIT_WORKER_ROLES.filter((candidate) => candidate !== "legacy-drain")) addLease(role, `${role}-1`);
    const topology = await aggregateTopologyReadiness(now);
    expect(topology.status).toBe("degraded");
    expect(topology.roles["legacy-drain"].required).toBe(true);
    expect(topology.capabilities.legacy_drain.ready).toBe(false);
  });

  it("allows non-production all mode to provide virtual role coverage", async () => {
    process.env.NODE_ENV = "test";
    addLease("all", "local-all");
    const topology = await aggregateTopologyReadiness(now);
    expect(topology.status).toBe("healthy");
    expect(Object.values(topology.roles).every((role) => role.ready)).toBe(true);
  });

  it("publishes only after successful registration and removes its lease on shutdown", async () => {
    await startRoleReadinessPublisher("intake-control");
    const members = mocks.leases.get(`${prefix}:members:intake-control`);
    expect(members).toEqual([roleReadinessTestUtils.instanceId]);
    expect(mocks.payloads.has(`${prefix}:lease:intake-control:${roleReadinessTestUtils.instanceId}`)).toBe(true);
    await Promise.all([stopRoleReadinessPublisher(), stopRoleReadinessPublisher()]);
    expect(mocks.leases.get(`${prefix}:members:intake-control`)).toEqual([]);
    expect(mocks.payloads.has(`${prefix}:lease:intake-control:${roleReadinessTestUtils.instanceId}`)).toBe(false);
  });

  it("fails startup closed when the initial distributed lease cannot be written", async () => {
    mocks.failWrites = true;
    await expect(startRoleReadinessPublisher("intake-control")).rejects.toThrow("lease write failed");
    expect(mocks.leases.get(`${prefix}:members:intake-control`) ?? []).toEqual([]);
  });

  it("keeps owner proof cycle-free when a CMS-backed startup hook fails", async () => {
    mocks.expectedHooks = ["source-run-dispatch-sweeper"];
    mocks.startupHookReadiness = [{
      hook: "source-run-dispatch-sweeper",
      status: "failed",
      attempts: 6,
      error: "CMS returned 503",
      updated_at: "2026-08-29T00:00:10.000Z",
    }];

    const readiness = await localRoleReadiness({ requireRegistryLease: false });

    expect(readiness.owner_ready).toBe(true);
    expect(readiness.pod_ready).toBe(false);
    expect(readiness.startup_hooks.failed).toEqual([
      { hook: "source-run-dispatch-sweeper", error: "CMS returned 503" },
    ]);
  });
});
