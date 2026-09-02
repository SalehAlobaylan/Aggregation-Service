import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ localRoleReadiness: vi.fn() }));
vi.mock("../../src/runtime/role-readiness.js", () => ({ localRoleReadiness: mocks.localRoleReadiness }));
vi.mock("../../src/config/index.js", () => ({ config: { storageEndpoint: "" } }));
vi.mock("../../src/observability/logger.js", () => ({ logger: { debug: vi.fn() } }));

import { readyRoutes } from "../../src/server/routes/ready.js";

const baseReadiness = {
  schema_version: "aggregation-role-readiness/v1",
  topology_schema_version: "aggregation-role-topology/v1",
  topology_digest: "a".repeat(64),
  instance_id: "instance",
  role: "intake-control",
  started_at: "2026-08-29T00:00:00.000Z",
  heartbeat_at: "2026-08-29T00:00:01.000Z",
  pod_ready: true,
  owner_ready: true,
  registry_lease_current: true,
  draining: false,
  dependencies: { redis: "connected", cms: "reachable", workers: "healthy" },
  workers: {},
  worker_ownership: {
    expected: ["fetch-queue"], registered: ["fetch-queue"], missing: [], unexpected: [],
    required_queue_clients: ["fetch-queue"], initialized_queue_clients: ["fetch-queue"],
    missing_queue_clients: [], unexpected_queue_clients: [],
  },
  reasons: [],
};

async function invokeReady() {
  let handler: ((request: unknown, reply: { status: (code: number) => unknown; send: (body: unknown) => unknown }) => Promise<unknown>) | undefined;
  const fastify = { get: (_path: string, registered: typeof handler) => { handler = registered; } };
  await readyRoutes(fastify as never);
  let statusCode = 200;
  const reply = {
    status(code: number) { statusCode = code; return reply; },
    send(body: unknown) { return body; },
  };
  const body = await handler?.({}, reply);
  return { statusCode, body };
}

describe("Aggregation role-local readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.localRoleReadiness.mockResolvedValue(baseReadiness);
  });

  it("returns 200 only for the exact ready role", async () => {
    await expect(invokeReady()).resolves.toMatchObject({
      statusCode: 200,
      body: {
        status: "ready", role: "intake-control", pod_ready: true, owner_ready: true,
        dependencies: { redis: "connected", cms: "reachable", workers: "healthy", storage: "configured" },
      },
    });
  });

  it.each([
    ["missing consumer", { pod_ready: false, dependencies: { redis: "connected", cms: "reachable", workers: "missing" } }],
    ["stale worker", { pod_ready: false, dependencies: { redis: "connected", cms: "reachable", workers: "stale" } }],
    ["CMS outage", { pod_ready: false, owner_ready: true, dependencies: { redis: "connected", cms: "unreachable", workers: "healthy" } }],
    ["lost distributed lease", { pod_ready: false, owner_ready: true, registry_lease_current: false }],
  ])("returns 503 for %s", async (_label, override) => {
    mocks.localRoleReadiness.mockResolvedValue({ ...baseReadiness, ...override });
    await expect(invokeReady()).resolves.toMatchObject({ statusCode: 503, body: { status: "not_ready" } });
  });

  it("keeps owner proof cycle-free when only CMS is unavailable", async () => {
    mocks.localRoleReadiness.mockResolvedValue({
      ...baseReadiness,
      pod_ready: false,
      owner_ready: true,
      dependencies: { redis: "connected", cms: "unreachable", workers: "healthy" },
    });
    await expect(invokeReady()).resolves.toMatchObject({
      statusCode: 503,
      body: { pod_ready: false, owner_ready: true },
    });
  });
});
