/**
 * Fastify server setup
 */
import Fastify, { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { healthRoutes } from './routes/health.js';
import { readyRoutes } from './routes/ready.js';
import { metricsRoutes } from './routes/metrics.js';
import { adminRoutes } from './routes/admin.js';

let server: FastifyInstance | null = null;

async function registerCors(fastify: FastifyInstance): Promise<void> {
    const corsOptions = {
        origin: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Authorization', 'Content-Type', 'Origin', 'Accept'],
    };

    try {
        const corsModuleName = '@fastify/cors';
        const corsModule = await import(corsModuleName);
        await fastify.register(corsModule.default, corsOptions);
        return;
    } catch (error) {
        logger.warn('Failed to load @fastify/cors, using fallback CORS handler', { error });
    }

    fastify.addHook('onRequest', async (request, reply) => {
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Authorization,Content-Type,Origin,Accept');

        if (request.method === 'OPTIONS') {
            await reply.status(204).send();
        }
    });
}

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
    await registerCors(fastify);

    await fastify.register(healthRoutes);
    await fastify.register(readyRoutes);
    await fastify.register(metricsRoutes);
    await fastify.register(adminRoutes);

    logger.info('Routes registered: /health, /ready, /metrics, /admin/*');
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
