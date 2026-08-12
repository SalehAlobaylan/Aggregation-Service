import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const workerInstances: Array<{
        name: string;
        close: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        pause: ReturnType<typeof vi.fn>;
        resume: ReturnType<typeof vi.fn>;
    }> = [];

    const Worker = vi.fn(function WorkerMock(this: {
        name: string;
        close: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        pause: ReturnType<typeof vi.fn>;
        resume: ReturnType<typeof vi.fn>;
    }, queueName: string) {
        const worker = {
            name: queueName,
            close: vi.fn().mockResolvedValue(undefined),
            on: vi.fn(),
            pause: vi.fn().mockResolvedValue(undefined),
            resume: vi.fn().mockResolvedValue(undefined),
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
        getRedisConnection: vi.fn(() => ({ status: 'ready' })),
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
    };
});

vi.mock('bullmq', () => ({
    Job: class Job { },
    Queue: mocks.Queue,
    Worker: mocks.Worker,
}));

vi.mock('../../src/config/index.js', () => ({
    config: {
        asyncTranscribeThresholdSec: 300,
        coldStoragePublicUrl: '',
        defaultJobTimeoutMs: 1000,
        logLevel: 'silent',
        maxStalledCount: 1,
        mediaJobTimeoutMs: 1000,
        mediaTempDir: '/tmp/wahb-worker-lifecycle-test',
        platformConsoleOrigins: ['http://localhost:3005'],
        reconcileBatch: 10,
        reconcileEnabled: false,
        reconcileIntervalMs: 60000,
        stalledIntervalMs: 30000,
        storagePublicUrl: 'https://storage.example.com',
        workerConcurrency: 1,
    },
    getRedactedConfig: vi.fn(() => ({})),
}));

vi.mock('../../src/observability/logger.js', () => ({
    logger: mocks.logger,
    createLogger: mocks.createLogger,
}));

vi.mock('../../src/observability/metrics.js', () => ({
    circuitState: mocks.metric,
    circuitTrips: mocks.metric,
    cmsLatency: mocks.metric,
    cmsRequestsTotal: mocks.metric,
    dlqSize: mocks.metric,
    jobDuration: mocks.metric,
    jobsTotal: mocks.metric,
    queueDepth: mocks.metric,
    registry: { metrics: vi.fn().mockResolvedValue(''), contentType: 'text/plain' },
    retryCount: mocks.metric,
}));

vi.mock('../../src/queues/redis.js', () => ({
    getRedisConnection: mocks.getRedisConnection,
}));

vi.mock('../../src/queues/index.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/queues/schemas.js')>('../../src/queues/schemas.js');
    return {
        ...actual,
        getQueue: vi.fn(() => undefined),
    };
});

vi.mock('../../src/cms/client.js', () => ({
    cmsClient: {
        listStoragePolicies: vi.fn(),
    },
}));

vi.mock('../../src/media/downloader.js', () => ({
    cleanupTempFile: vi.fn(),
    downloadHttp: vi.fn(),
    downloadTelegram: vi.fn(),
    downloadYouTube: vi.fn(),
    isAllowedYouTubeUrl: vi.fn(),
}));

vi.mock('../../src/media/transcoder.js', () => ({
    audioToMp4: vi.fn(),
    containerExtension: vi.fn(() => 'mp4'),
    containerMime: vi.fn(() => 'video/mp4'),
    extractThumbnail: vi.fn(),
    getMediaInfo: vi.fn(),
    transcodeToMp4: vi.fn(),
}));

vi.mock('../../src/media/captions.js', () => ({
    captionsToFullText: vi.fn(),
}));

vi.mock('../../src/storage/client.js', () => ({
    computeStorageUsage: vi.fn(),
    deleteContentObjects: vi.fn(),
    deleteObjectsByKeys: vi.fn(),
    getPublicUrl: vi.fn(),
    getStorageKey: vi.fn(),
    isColdTierConfigured: vi.fn(() => false),
    objectExists: vi.fn(),
    uploadFile: vi.fn(),
}));

vi.mock('../../src/services/quality.service.js', () => ({
    preflightCheck: vi.fn(),
    probeContentItem: vi.fn(),
    resolveIngestProfile: vi.fn(),
}));

vi.mock('../../src/services/storage.service.js', () => ({
    reconcileStorage: vi.fn(),
    runSweepForTenant: vi.fn(),
}));

vi.mock('../../src/workers/op-metrics-flush.worker.js', () => ({
    startOpMetricsFlush: vi.fn(),
}));

vi.mock('../../src/services/cloudflare-analytics.service.js', () => ({
    startCloudflareAnalyticsPuller: vi.fn(),
}));

describe('worker lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workerInstances.length = 0;
    });

    it('does not construct BullMQ workers when route and registry modules are imported', async () => {
        await import('../../src/server/index.js');
        await import('../../src/server/routes/admin.js');
        const workers = await import('../../src/workers/index.js');

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
});
