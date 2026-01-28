/**
 * Ready endpoint - readiness check with dependency status
 * GET /ready
 */
import { FastifyInstance } from 'fastify';
import { isRedisConnected } from '../../queues/redis.js';
import { cmsClient } from '../../cms/client.js';
import { config } from '../../config/index.js';
import { logger } from '../../observability/logger.js';

type DependencyStatus = 'connected' | 'disconnected' | 'reachable' | 'unreachable' | 'configured';

interface ReadyResponse {
    status: 'ready' | 'not_ready';
    dependencies: {
        redis: DependencyStatus;
        cms: DependencyStatus;
        storage: DependencyStatus;
    };
}

export async function readyRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.get<{ Reply: ReadyResponse }>('/ready', async (_request, reply) => {
        // Check Redis
        const redisConnected = await isRedisConnected();
        const redisStatus: DependencyStatus = redisConnected ? 'connected' : 'disconnected';

        // Check CMS via circuit breaker
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
                    const response = await fetch(config.storageEndpoint, {
                        method: 'HEAD',
                        signal: controller.signal,
                    });
                    clearTimeout(timeout);
                    storageStatus = response.ok || response.status === 403 ? 'reachable' : 'unreachable';
                } catch {
                    clearTimeout(timeout);
                    // If storage URL is configured but unreachable, still mark as configured in Phase 1
                    storageStatus = 'configured';
                }
            }
        } catch (error) {
            logger.debug('Storage check failed during readiness check', { error });
            storageStatus = 'configured';
        }

        // Determine overall status
        const isReady = redisStatus === 'connected';
        // Note: CMS and storage being unreachable shouldn't block readiness
        // Redis is the critical dependency for queue operations

        return reply.send({
            status: isReady ? 'ready' : 'not_ready',
            dependencies: {
                redis: redisStatus,
                cms: cmsStatus,
                storage: storageStatus,
            },
        });
    });
}
