/**
 * Ready endpoint - readiness check with dependency status
 * GET /ready
 */
import { FastifyInstance } from 'fastify';
import { isRedisConnected } from '../../queues/redis.js';
import { cmsClient } from '../../cms/client.js';
import { CircuitState } from '../../cms/circuit-breaker.js';
import { config } from '../../config/index.js';
import { logger } from '../../observability/logger.js';

type DependencyStatus = 'connected' | 'disconnected' | 'reachable' | 'unreachable' | 'configured' | 'circuit_open';

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

        // Check CMS circuit breaker state first: if OPEN, the breaker is
        // actively rejecting calls — pinging would just trickle through and
        // hide that we cannot write results back. Reporting not_ready here
        // lets the orchestrator stop routing new work until CMS recovers.
        const breakerState = cmsClient.getCircuitBreaker().getState();
        let cmsStatus: DependencyStatus = 'unreachable';
        if (breakerState === CircuitState.OPEN) {
            cmsStatus = 'circuit_open';
        } else {
            try {
                const cmsPing = await cmsClient.ping();
                cmsStatus = cmsPing ? 'reachable' : 'unreachable';
            } catch (error) {
                logger.debug('CMS ping failed during readiness check', { error });
                cmsStatus = 'unreachable';
            }
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

        // Determine overall status. Redis is the queue backbone; an OPEN
        // CMS circuit breaker means write-backs would fail silently, so we
        // also gate readiness on that. Transient unreachability (still
        // CLOSED/HALF_OPEN) is tolerated.
        const isReady =
            redisStatus === 'connected' && cmsStatus !== 'circuit_open';

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
