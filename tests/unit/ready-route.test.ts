import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isRedisConnected: vi.fn(),
    ping: vi.fn(),
    getWorkerLiveness: vi.fn(),
    mandatoryWorkersHealthy: vi.fn(),
    getAllWorkers: vi.fn(),
}));

vi.mock('../../src/queues/redis.js', () => ({ isRedisConnected: mocks.isRedisConnected }));
vi.mock('../../src/cms/client.js', () => ({
    cmsClient: {
        ping: mocks.ping,
        // Deliberately present and OPEN-looking: readiness must not consult it.
        getCircuitBreaker: () => ({ getState: () => 1 }),
    },
}));
vi.mock('../../src/config/index.js', () => ({ config: { storageEndpoint: '' } }));
vi.mock('../../src/observability/logger.js', () => ({ logger: { debug: vi.fn() } }));
vi.mock('../../src/workers/index.js', () => ({ getAllWorkers: mocks.getAllWorkers }));
vi.mock('../../src/workers/worker-liveness.js', () => ({
    getWorkerLiveness: mocks.getWorkerLiveness,
    mandatoryWorkersHealthy: mocks.mandatoryWorkersHealthy,
}));

import { readyRoutes } from '../../src/server/routes/ready.js';

describe('Aggregation readiness', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isRedisConnected.mockResolvedValue(true);
        mocks.ping.mockResolvedValue(true);
        mocks.mandatoryWorkersHealthy.mockReturnValue(true);
        mocks.getWorkerLiveness.mockReturnValue({});
        mocks.getAllWorkers.mockReturnValue([
            'fetch-queue', 'normalize-queue', 'source-run-dispatch-queue',
            'source-run-verification-queue', 'lifecycle-receipts-queue',
            'pipeline-repair-queue', 'atomization-queue', 'atomization-sweep-queue',
        ].map((name) => ({ name })));
    });

    it('uses cycle-free CMS liveness and independent worker proof', async () => {
        let handler: ((request: unknown, reply: { send: (body: unknown) => unknown }) => Promise<unknown>) | undefined;
        const fastify = {
            get: (_path: string, registered: typeof handler) => { handler = registered; },
        };
        await readyRoutes(fastify as never);
        const send = vi.fn((body) => body);
        const result = await handler?.({}, { send });

        expect(mocks.ping).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            status: 'ready',
            dependencies: { redis: 'connected', cms: 'reachable', workers: 'healthy' },
        });
    });
});
