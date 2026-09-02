import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const workerInstances: Array<{
    name: string;
    close: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  }> = [];

  const Worker = vi.fn(function WorkerMock(
    this: {
      name: string;
      close: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      run: ReturnType<typeof vi.fn>;
    },
    queueName: string,
  ) {
    const worker = {
      name: queueName,
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(() => new Promise<void>(() => undefined)),
    };
    Object.assign(this, worker);
    workerInstances.push(this);
  });

  const labels = vi.fn(() => ({
    inc: vi.fn(),
    observe: vi.fn(),
    set: vi.fn(),
  }));

  return {
    Worker,
    Queue: vi.fn(),
    workerInstances,
    getRedisConnection: vi.fn(() => ({ status: "ready" })),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    metric: { labels, inc: vi.fn(), observe: vi.fn(), set: vi.fn() },
    queueRole: "all",
    queueNames: [] as string[],
  };
});

vi.mock("bullmq", () => ({
  Job: class Job {},
  Queue: mocks.Queue,
  Worker: mocks.Worker,
}));

vi.mock("../../src/config/index.js", () => ({
  config: {
    asyncTranscribeThresholdSec: 300,
    coldStoragePublicUrl: "",
    defaultJobTimeoutMs: 1000,
    logLevel: "silent",
    maxStalledCount: 1,
    mediaJobTimeoutMs: 1000,
    mediaTempDir: "/tmp/wahb-worker-lifecycle-test",
    platformConsoleOrigins: ["http://localhost:3005"],
    reconcileBatch: 10,
    reconcileEnabled: false,
    reconcileIntervalMs: 60000,
    stalledIntervalMs: 30000,
    storagePublicUrl: "https://storage.example.com",
    workerConcurrency: 1,
  },
  getRedactedConfig: vi.fn(() => ({})),
}));

vi.mock("../../src/observability/logger.js", () => ({
  logger: mocks.logger,
  createLogger: mocks.createLogger,
}));

vi.mock("../../src/observability/metrics.js", () => ({
  circuitState: mocks.metric,
  circuitTrips: mocks.metric,
  cmsLatency: mocks.metric,
  cmsRequestsTotal: mocks.metric,
  dlqSize: mocks.metric,
  jobDuration: mocks.metric,
  jobsTotal: mocks.metric,
  queueDepth: mocks.metric,
  registry: {
    metrics: vi.fn().mockResolvedValue(""),
    contentType: "text/plain",
  },
  retryCount: mocks.metric,
}));

vi.mock("../../src/queues/redis.js", () => ({
  getRedisConnection: mocks.getRedisConnection,
}));

vi.mock("../../src/queues/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/queues/schemas.js")
  >("../../src/queues/schemas.js");
  return {
    ...actual,
    getQueue: vi.fn(() => undefined),
    getInitializedQueueRole: vi.fn(() => mocks.queueRole),
    getInitializedQueueNames: vi.fn(() => mocks.queueNames.length ? mocks.queueNames : Object.values(actual.QUEUE_NAMES)),
  };
});

vi.mock("../../src/cms/client.js", () => ({
  cmsClient: {
    listStoragePolicies: vi.fn(),
  },
}));

vi.mock("../../src/media/downloader.js", () => ({
  cleanupTempFile: vi.fn(),
  downloadHttp: vi.fn(),
  downloadTelegram: vi.fn(),
  downloadYouTube: vi.fn(),
  isAllowedYouTubeUrl: vi.fn(),
}));

vi.mock("../../src/media/transcoder.js", () => ({
  containerExtension: vi.fn(() => "mp4"),
  containerMime: vi.fn(() => "video/mp4"),
  extractThumbnail: vi.fn(),
  getMediaInfo: vi.fn(),
  transcodeToMp4: vi.fn(),
}));

vi.mock("../../src/media/captions.js", () => ({
  captionsToFullText: vi.fn(),
}));

vi.mock("../../src/storage/client.js", () => ({
  computeStorageUsage: vi.fn(),
  deleteContentObjects: vi.fn(),
  deleteObjectsByKeys: vi.fn(),
  getPublicUrl: vi.fn(),
  getStorageKey: vi.fn(),
  isColdTierConfigured: vi.fn(() => false),
  objectExists: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("../../src/services/quality.service.js", () => ({
  preflightCheck: vi.fn(),
  probeContentItem: vi.fn(),
  resolveIngestProfile: vi.fn(),
}));

vi.mock("../../src/services/storage.service.js", () => ({
  reconcileStorage: vi.fn(),
  runSweepForTenant: vi.fn(),
}));

vi.mock("../../src/workers/op-metrics-flush.worker.js", () => ({
  startOpMetricsFlush: vi.fn(),
  stopOpMetricsFlush: vi.fn(),
}));

vi.mock("../../src/services/cloudflare-analytics.service.js", () => ({
  startCloudflareAnalyticsPuller: vi.fn(),
  stopCloudflareAnalyticsPuller: vi.fn(),
}));

describe("worker lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workerInstances.length = 0;
    mocks.queueRole = "all";
    mocks.queueNames = [];
  });

  it("does not construct BullMQ workers when route and registry modules are imported", async () => {
    await import("../../src/server/index.js");
    await import("../../src/server/routes/admin.js");
    const workers = await import("../../src/workers/index.js");

    expect(mocks.Worker).not.toHaveBeenCalled();
    expect(workers.getAllWorkers()).toEqual([]);

    await workers.startWorkers();

    // The registry grows as durable, capability-scoped workers are added.
    // Assert lifecycle convergence rather than freezing a stale worker
    // count that would hide an unregistered new owner.
    const registeredCount = mocks.Worker.mock.calls.length;
    expect(registeredCount).toBeGreaterThan(0);
    expect(workers.getAllWorkers()).toHaveLength(registeredCount);

    await workers.startWorkers();
    expect(mocks.Worker).toHaveBeenCalledTimes(registeredCount);

    await workers.closeWorkers();
    expect(workers.getAllWorkers()).toEqual([]);
    for (const worker of mocks.workerInstances) {
      expect(worker.close).toHaveBeenCalledTimes(1);
    }
  });

  it("constructs and runs exactly the consumers declared for every explicit role", async () => {
    const workers = await import("../../src/workers/index.js");
    const { resolveRoleTopology, WORKER_ROLES } = await import("../../src/runtime/role-topology.js");

    for (const role of WORKER_ROLES.filter((candidate) => candidate !== "all")) {
      mocks.queueRole = role;
      mocks.queueNames = [...resolveRoleTopology(role).queueClients];
      await workers.startWorkers(role);
      const expected = resolveRoleTopology(role).consumerQueues;
      expect(workers.getAllWorkers().map((worker) => worker.name)).toEqual(expected);
      expect(workers.getAllWorkers().every((worker) => mocks.workerInstances.includes(worker as never))).toBe(true);
      for (const worker of workers.getAllWorkers()) {
        expect((worker as unknown as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalledTimes(1);
      }
      await workers.closeWorkers();
      expect(workers.getAllWorkers()).toEqual([]);
    }
  });

  it("rejects a conflicting role while preserving same-role startup idempotency", async () => {
    const workers = await import("../../src/workers/index.js");
    mocks.queueRole = "news";
    mocks.queueNames = [...(await import("../../src/runtime/role-topology.js")).resolveRoleTopology("news").queueClients];
    await workers.startWorkers("news");
    const constructed = mocks.Worker.mock.calls.length;
    await workers.startWorkers("news");
    expect(mocks.Worker).toHaveBeenCalledTimes(constructed);
    await expect(workers.startWorkers("media-executor")).rejects.toThrow("already active");
    await workers.closeWorkers();
  });

  it("coalesces concurrent shutdown calls and closes each worker once", async () => {
    const workers = await import("../../src/workers/index.js");
    mocks.queueRole = "news";
    mocks.queueNames = [...(await import("../../src/runtime/role-topology.js")).resolveRoleTopology("news").queueClients];
    await workers.startWorkers("news");
    await Promise.all([workers.closeWorkers(), workers.closeWorkers()]);
    for (const worker of mocks.workerInstances) expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it("closes a partially constructed cohort when a later factory fails", async () => {
    const workers = await import("../../src/workers/index.js");
    const { WORKER_DESCRIPTORS } = await import("../../src/runtime/role-topology.js");
    const original = WORKER_DESCRIPTORS.normalize.loadFactory;
    WORKER_DESCRIPTORS.normalize.loadFactory = async () => { throw new Error("factory unavailable"); };
    mocks.queueRole = "intake-control";
    mocks.queueNames = [...(await import("../../src/runtime/role-topology.js")).resolveRoleTopology("intake-control").queueClients];
    try {
      await expect(workers.startWorkers("intake-control")).rejects.toThrow("factory unavailable");
      expect(workers.getAllWorkers()).toEqual([]);
      expect(mocks.workerInstances).toHaveLength(1);
      expect(mocks.workerInstances[0]?.close).toHaveBeenCalledTimes(1);
    } finally {
      WORKER_DESCRIPTORS.normalize.loadFactory = original;
    }
  });
});
