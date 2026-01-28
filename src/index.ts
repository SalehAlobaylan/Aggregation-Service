/**
 * Aggregation Service - Main entry point
 * 
 * This is a worker-first service that:
 * - Runs BullMQ workers for content processing pipeline
 * - Exposes internal Fastify endpoints for health/ready/metrics
 * - Never serves user-facing API traffic
 */
import { config } from './config/index.js';
import { logger } from './observability/logger.js';
import { getRedisConnection, closeRedisConnection } from './queues/redis.js';
import { initializeQueues, closeQueues } from './queues/index.js';
import { startWorkers, closeWorkers } from './workers/index.js';
import { startServer, stopServer } from './server/index.js';

async function main(): Promise<void> {
    logger.info('Starting Aggregation Service...');
    logger.info('Configuration loaded', {
        cmsBaseUrl: config.cmsBaseUrl,
        redisUrl: config.redisUrl.replace(/\/\/.*@/, '//<redacted>@'), // Redact password if present
        storageEndpoint: config.storageEndpoint,
        storageBucket: config.storageBucket,
        workerConcurrency: config.workerConcurrency,
        logLevel: config.logLevel,
        metricsPort: config.metricsPort,
    });

    try {
        // Initialize Redis connection
        logger.info('Connecting to Redis...');
        getRedisConnection();

        // Initialize queues
        logger.info('Initializing queues...');
        initializeQueues();

        // Start workers
        logger.info('Starting workers...');
        startWorkers();

        // Start HTTP server
        logger.info('Starting HTTP server...');
        await startServer();

        logger.info('Aggregation Service started successfully');
    } catch (error) {
        logger.error('Failed to start Aggregation Service', error);
        process.exit(1);
    }
}

// Graceful shutdown handler
async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
        // Stop accepting new work
        await stopServer();

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
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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
