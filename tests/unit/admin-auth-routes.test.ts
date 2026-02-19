import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const queueGetJobCounts = vi.fn().mockResolvedValue({
    waiting: 1,
    active: 2,
    completed: 3,
    failed: 0,
    delayed: 0,
});

vi.mock('../../src/queues/index.js', () => ({
    QUEUE_NAMES: {
        FETCH: 'fetch-queue',
        NORMALIZE: 'normalize-queue',
    },
    getQueue: vi.fn().mockImplementation(() => ({
        getJobCounts: queueGetJobCounts,
        getJob: vi.fn().mockResolvedValue(null),
    })),
}));

vi.mock('../../src/services/scheduler.service.js', () => ({
    scheduler: {
        triggerPoll: vi.fn().mockResolvedValue('job-123'),
        getScheduledJobs: vi.fn().mockResolvedValue([]),
    },
}));

vi.mock('../../src/services/rate-limiter.js', () => ({
    rateLimiter: {
        getRateLimits: vi.fn().mockReturnValue({}),
        getRateLimitStatus: vi.fn().mockResolvedValue({
            current: 0,
            max: 60,
            remaining: 60,
            windowMs: 60000,
        }),
    },
}));

vi.mock('../../src/services/itunes-search.js', () => ({
    itunesSearch: {
        isEnabled: vi.fn().mockReturnValue(false),
        searchPodcasts: vi.fn().mockResolvedValue({}),
    },
}));

function makeJwt(
    payload: Record<string, unknown>,
    secret: string
): string {
    const header = Buffer.from(
        JSON.stringify({ alg: 'HS256', typ: 'JWT' })
    ).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret)
        .update(`${header}.${body}`)
        .digest('base64url');
    return `${header}.${body}.${signature}`;
}

async function buildServer(): Promise<FastifyInstance> {
    vi.resetModules();

    process.env.CMS_BASE_URL = 'http://localhost:8080/internal';
    process.env.CMS_SERVICE_TOKEN = 'test-token';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.STORAGE_ENDPOINT = 'http://localhost:9000';
    process.env.STORAGE_BUCKET = 'test-bucket';
    process.env.STORAGE_ACCESS_KEY = 'key';
    process.env.STORAGE_SECRET_KEY = 'secret';
    process.env.STORAGE_PUBLIC_URL = 'http://localhost:9000';
    process.env.WHISPER_API_URL = 'http://localhost:9002';
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.ADMIN_JWT_ISSUER = 'cms-service';
    process.env.ADMIN_JWT_AUDIENCE = 'platform-console';
    process.env.ADMIN_ALLOWED_ROLES = 'admin,manager';
    process.env.PLATFORM_CONSOLE_ORIGINS = 'http://localhost:3005';

    const { createServer, registerRoutes } = await import('../../src/server/index.js');
    const fastify = createServer();
    await registerRoutes(fastify);
    return fastify;
}

describe('Admin auth and route protections', () => {
    afterEach(async () => {
        vi.clearAllMocks();
    });

    it('keeps /health public', async () => {
        const server = await buildServer();
        const response = await server.inject({
            method: 'GET',
            url: '/health',
        });
        expect(response.statusCode).toBe(200);
        await server.close();
    });

    it('returns 401 when admin token is missing', async () => {
        const server = await buildServer();
        const response = await server.inject({
            method: 'GET',
            url: '/admin/queues',
        });
        expect(response.statusCode).toBe(401);
        await server.close();
    });

    it('returns 401 for invalid signature', async () => {
        const server = await buildServer();
        const token = makeJwt(
            {
                iss: 'cms-service',
                aud: 'platform-console',
                role: 'admin',
                exp: Math.floor(Date.now() / 1000) + 3600,
            },
            'wrong-secret'
        );

        const response = await server.inject({
            method: 'GET',
            url: '/admin/queues',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(401);
        await server.close();
    });

    it('returns 403 for disallowed role', async () => {
        const server = await buildServer();
        const token = makeJwt(
            {
                iss: 'cms-service',
                aud: 'platform-console',
                role: 'agent',
                exp: Math.floor(Date.now() / 1000) + 3600,
            },
            'test-jwt-secret'
        );

        const response = await server.inject({
            method: 'GET',
            url: '/admin/queues',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(403);
        await server.close();
    });

    it('allows admin and manager roles', async () => {
        const server = await buildServer();
        const adminToken = makeJwt(
            {
                iss: 'cms-service',
                aud: 'platform-console',
                role: 'admin',
                exp: Math.floor(Date.now() / 1000) + 3600,
            },
            'test-jwt-secret'
        );
        const managerToken = makeJwt(
            {
                iss: 'cms-service',
                aud: 'platform-console',
                role: 'manager',
                exp: Math.floor(Date.now() / 1000) + 3600,
            },
            'test-jwt-secret'
        );

        const adminResponse = await server.inject({
            method: 'GET',
            url: '/admin/queues',
            headers: { authorization: `Bearer ${adminToken}` },
        });
        const managerResponse = await server.inject({
            method: 'GET',
            url: '/admin/queues',
            headers: { authorization: `Bearer ${managerToken}` },
        });

        expect(adminResponse.statusCode).toBe(200);
        expect(managerResponse.statusCode).toBe(200);
        await server.close();
    });

    it('sets CORS headers for allowed origin and blocks disallowed origin', async () => {
        const server = await buildServer();
        const token = makeJwt(
            {
                iss: 'cms-service',
                aud: 'platform-console',
                role: 'admin',
                exp: Math.floor(Date.now() / 1000) + 3600,
            },
            'test-jwt-secret'
        );

        const allowedOriginResponse = await server.inject({
            method: 'OPTIONS',
            url: '/admin/queues',
            headers: {
                origin: 'http://localhost:3005',
                authorization: `Bearer ${token}`,
                'access-control-request-method': 'GET',
                'access-control-request-headers': 'authorization,content-type',
            },
        });
        expect(allowedOriginResponse.statusCode).toBe(204);
        expect(allowedOriginResponse.headers['access-control-allow-origin']).toBe(
            'http://localhost:3005'
        );

        const disallowedOriginResponse = await server.inject({
            method: 'OPTIONS',
            url: '/admin/queues',
            headers: {
                origin: 'http://malicious.example',
                authorization: `Bearer ${token}`,
                'access-control-request-method': 'GET',
                'access-control-request-headers': 'authorization,content-type',
            },
        });
        expect(disallowedOriginResponse.statusCode).toBeGreaterThanOrEqual(400);
        await server.close();
    });
});
