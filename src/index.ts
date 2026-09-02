/**
 * Aggregation Service - Main entry point
 * 
 * This is a worker-first service that:
 * - Runs BullMQ workers for content processing pipeline
 * - Exposes internal Fastify endpoints for health/ready/metrics
 * - Never serves user-facing API traffic
 */
import { config, getRedactedConfig } from './config/index.js';
import { logger } from './observability/logger.js';
import { getRedisConnection, closeRedisConnection } from './queues/redis.js';
import { initializeQueues, closeQueues } from './queues/index.js';
import { startWorkers, closeWorkers, type WorkerRole } from './workers/index.js';
import { startServer, stopServer } from './server/index.js';
import { isWorkerRole } from './runtime/role-topology.js';
import { startRoleReadinessPublisher, stopRoleReadinessPublisher } from './runtime/role-readiness.js';

let shutdownPromise: Promise<void> | null = null;

export function resolveRequestedRole(argvRole = process.argv[2], environmentRole = process.env.ROLE): WorkerRole {
	const requested = argvRole ?? 'all';
	if (!isWorkerRole(requested)) throw new Error(`Unknown Aggregation role: ${requested}`);
	if (environmentRole && environmentRole !== requested) {
		throw new Error(`Aggregation role mismatch: command requested ${requested}, ROLE declares ${environmentRole}`);
	}
	if (requested === 'all' && process.env.NODE_ENV === 'production') {
		throw new Error('The mixed Aggregation role is disabled in production; select an explicit role');
	}
	process.env.ROLE = requested;
	return requested;
}

async function main(): Promise<void> {
	const requestedRole = resolveRequestedRole();
    logger.info('Starting Aggregation Service...', { role: requestedRole });
    logger.info('Configuration loaded', getRedactedConfig(config));
    logger.info('Connection targets', {
        cmsBaseUrl: config.cmsBaseUrl,
        redisUrl: config.redisUrl.replace(/\/\/.*@/, '//<redacted>@'),
        storageEndpoint: config.storageEndpoint,
        enrichmentBaseUrl: config.enrichmentBaseUrl,
        metricsPort: config.metricsPort,
        platformConsoleOrigins: config.platformConsoleOrigins,
    });

    try {
        // Initialize Redis connection
        logger.info('Connecting to Redis...');
        getRedisConnection();

        // Initialize queues
        logger.info('Initializing queues...');
        initializeQueues(requestedRole);

        // Start workers
        logger.info('Starting workers...');
        await startWorkers(requestedRole);

		// Publish only after the complete role cohort has passed exact ownership
		// validation. CMS consumes these leases as cycle-free owner evidence.
		await startRoleReadinessPublisher(requestedRole);

		// Every explicit role exposes its own liveness/readiness surface. The
		// role deployments do not share a process or pod, so the per-container
		// port remains isolated while orchestration can probe every role.
		logger.info('Starting HTTP server for role...', { role: requestedRole });
		await startServer();

        logger.info('Aggregation Service started successfully');
    } catch (error) {
        logger.error('Failed to start Aggregation Service', error);
        process.exit(1);
    }
}

// Graceful shutdown handler
async function shutdown(signal: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    const promise = performShutdown(signal);
    shutdownPromise = promise;
    return promise;
}

async function performShutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
        // Withdraw distributed owner evidence before closing the HTTP surface
        // or workers. A killed process is covered by the bounded Redis TTL.
		await stopRoleReadinessPublisher();

        // Stop accepting new work
		await stopServer().catch(() => undefined);

        // Wait for workers to finish current jobs
        await closeWorkers();

        // Close queues
        await closeQueues();

        // Close Redis connection
        await closeRedisConnection();

        logger.info('Aggregation Service stopped gracefully');
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', error);
        process.exit(1);
    }
}

// Register shutdown handlers
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', reason as Error);
    process.exit(1);
});

// Start the service
main();
