/**
 * Fastify server setup
 */
import Fastify, { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { healthRoutes } from './routes/health.js';
import { readyRoutes } from './routes/ready.js';
import { metricsRoutes } from './routes/metrics.js';

let server: FastifyInstance | null = null;

/**
 * Create and configure Fastify server
 */
export function createServer(): FastifyInstance {
    const fastify = Fastify({
        logger: {
            level: config.logLevel,
        },
    });

    return fastify;
}

/**
 * Register all routes
 */
export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
    await fastify.register(healthRoutes);
    await fastify.register(readyRoutes);
    await fastify.register(metricsRoutes);

    logger.info('Routes registered: /health, /ready, /metrics');
}

/**
 * Start the server
 */
export async function startServer(): Promise<FastifyInstance> {
    server = createServer();
    await registerRoutes(server);

    const port = config.metricsPort;
    const host = '0.0.0.0';

    await server.listen({ port, host });
    logger.info(`Server listening on http://${host}:${port}`);

    return server;
}

/**
 * Stop the server
 */
export async function stopServer(): Promise<void> {
    if (server) {
        await server.close();
        server = null;
        logger.info('Server stopped');
    }
}

/**
 * Get the server instance
 */
export function getServer(): FastifyInstance | null {
    return server;
}
