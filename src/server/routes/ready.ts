/**
 * Ready endpoint - readiness check with dependency status
 * GET /ready
 */
import { FastifyInstance } from 'fastify';
import { isRedisConnected } from '../../queues/redis.js';
import { cmsClient } from '../../cms/client.js';
import { config } from '../../config/index.js';
import { logger } from '../../observability/logger.js';
import { getAllWorkers } from '../../workers/index.js';
import { getWorkerLiveness, mandatoryWorkersHealthy } from '../../workers/worker-liveness.js';

type DependencyStatus = 'connected' | 'disconnected' | 'reachable' | 'unreachable' | 'configured' | 'circuit_open' | 'healthy' | 'stale' | 'missing';

interface ReadyResponse {
    status: 'ready' | 'not_ready';
    dependencies: {
        redis: DependencyStatus;
        cms: DependencyStatus;
        storage: DependencyStatus;
        workers: DependencyStatus;
    };
    workers: ReturnType<typeof getWorkerLiveness>;
}

export async function readyRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.get<{ Reply: ReadyResponse }>('/ready', async (_request, reply) => {
        // Check Redis
        const redisConnected = await isRedisConnected();
        const redisStatus: DependencyStatus = redisConnected ? 'connected' : 'disconnected';

        // Liveness is independent from the operational request circuit. CMS
        // consumes this endpoint as owner-worker evidence, so including the
        // CMS circuit here would make each service wait for the other to
        // become ready. Operational degradation remains visible through the
        // circuit metrics and failed claim telemetry.
        let cmsStatus: DependencyStatus = 'unreachable';
        try {
            const cmsPing = await cmsClient.ping();
            cmsStatus = cmsPing ? 'reachable' : 'unreachable';
        } catch (error) {
            logger.debug('CMS ping failed during readiness check', { error });
            cmsStatus = 'unreachable';
        }

        // Check Storage - best effort
        // In Phase 1, just mark as "configured" if URL is set
        let storageStatus: DependencyStatus = 'configured';
        try {
            if (config.storageEndpoint) {
                // Try a lightweight HEAD request to storage
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 5000);

                try {
                    await fetch(config.storageEndpoint, {
                        method: 'HEAD',
                        signal: controller.signal,
                    });
                    clearTimeout(timeout);
                    // ANY HTTP response means the endpoint is reachable. An
                    // unauthenticated bare HEAD to an S3/R2 endpoint legitimately
                    // returns 400/401/403 (no bucket, no signature) — that is NOT
                    // an outage, and authenticated PutObject still works. Only a
                    // network-level failure (fetch throws below) is unreachable.
                    storageStatus = 'reachable';
                } catch {
                    clearTimeout(timeout);
                    storageStatus = 'unreachable';
                }
            }
        } catch (error) {
            logger.debug('Storage check failed during readiness check', { error });
            storageStatus = 'configured';
        }

        // Redis, CMS liveness and mandatory owner workers are required before
        // this service can safely accept a new handoff.
		const mandatoryWorkers = ['fetch-queue','normalize-queue','source-run-dispatch-queue','source-run-verification-queue','lifecycle-receipts-queue','pipeline-repair-queue','atomization-queue','atomization-sweep-queue'] as const;
		const registeredWorkers = new Set(getAllWorkers().map((worker) => worker.name));
        const workerLiveness = getWorkerLiveness();
        const allRegistered = mandatoryWorkers.every((name) => registeredWorkers.has(name));
        const workersStatus: DependencyStatus = !allRegistered ? 'missing' : mandatoryWorkersHealthy(mandatoryWorkers) ? 'healthy' : 'stale';
		const isReady = redisStatus === 'connected' && cmsStatus === 'reachable' && workersStatus === 'healthy';

        return reply.send({
            status: isReady ? 'ready' : 'not_ready',
            dependencies: {
                redis: redisStatus,
                cms: cmsStatus,
                storage: storageStatus,
				workers: workersStatus,
            },
            workers: workerLiveness,
        });
    });
}
