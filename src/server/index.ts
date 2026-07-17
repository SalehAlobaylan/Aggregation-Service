/**
 * Fastify server setup
 */
import Fastify, { FastifyInstance } from 'fastify';
import type { FastifyCorsOptions } from '@fastify/cors';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { healthRoutes } from './routes/health.js';
import { readyRoutes } from './routes/ready.js';
import { metricsRoutes } from './routes/metrics.js';
import { adminRoutes } from './routes/admin.js';
import { internalRoutes } from './routes/internal.js';

let server: FastifyInstance | null = null;

async function registerCors(fastify: FastifyInstance): Promise<void> {
    const allowedOrigins = new Set(config.platformConsoleOrigins);
    const corsOptions: FastifyCorsOptions = {
        origin: (origin, callback) => {
            callback(null, !origin || allowedOrigins.has(origin));
        },
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
        const origin = request.headers.origin;
        if (origin && allowedOrigins.has(origin)) {
            reply.header('Access-Control-Allow-Origin', origin);
        }
        reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Authorization,Content-Type,Origin,Accept');

        if (request.method === 'OPTIONS') {
            await reply.status(origin && !allowedOrigins.has(origin) ? 403 : 204).send();
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
    await registerMultipart(fastify);

    await fastify.register(healthRoutes);
    await fastify.register(readyRoutes);
    await fastify.register(metricsRoutes);
    await fastify.register(adminRoutes);
    await fastify.register(internalRoutes);

    logger.info('Routes registered: /health, /ready, /metrics, /admin/*, /internal/*');
}

async function registerMultipart(fastify: FastifyInstance): Promise<void> {
    try {
        // Dynamic import keeps the dep optional at startup and lets Node
        // resolve the ESM package correctly.
        const moduleName = '@fastify/multipart';
        const mod = await import(moduleName);
        await fastify.register(mod.default, {
            limits: {
                // CMS permits up to 200 MiB for user audio. This is still
                // enforced again while the internal route streams the file to
                // disk: multipart metadata and Content-Length are advisory.
                fileSize: 200 * 1024 * 1024,
                files: 1,
                fields: 3,
                parts: 4,
                fieldNameSize: 64,
                fieldSize: 256,
            },
        });
    } catch (error) {
        logger.error('Failed to register @fastify/multipart', { error });
        throw error;
    }
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
