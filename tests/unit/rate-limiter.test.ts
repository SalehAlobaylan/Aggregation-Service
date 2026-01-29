/**
 * Rate Limiter Tests
 * Tests the rate limiting service with Redis
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Prevent process.exit during tests
vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
});

// Mock console.error to suppress config error output
vi.spyOn(console, 'error').mockImplementation(() => { });

// Mock Redis before importing rate-limiter
vi.mock('../../src/queues/redis.js', () => {
    const mockRedis = {
        zremrangebyscore: vi.fn().mockResolvedValue(0),
        zcard: vi.fn().mockResolvedValue(0),
        zadd: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
        zrange: vi.fn().mockResolvedValue([]),
    };
    return {
        getRedisConnection: () => mockRedis,
        __mockRedis: mockRedis,
    };
});

// Mock metrics
vi.mock('../../src/observability/metrics.js', () => ({
    rateLimitHits: { inc: vi.fn() },
}));

// Mock logger to prevent config import
vi.mock('../../src/observability/logger.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

// Mock config to prevent exit
vi.mock('../../src/config/index.js', () => ({
    config: {
        rateLimitWindowMs: 60000,
        rateLimitMaxRequests: 100,
    },
}));

describe('Rate Limiter', () => {
    let rateLimiter: typeof import('../../src/services/rate-limiter.js').rateLimiter;
    let mockRedis: any;

    beforeEach(async () => {
        vi.resetModules();
        const redisModule = await import('../../src/queues/redis.js');
        mockRedis = (redisModule as any).__mockRedis;

        // Reset mock return values
        mockRedis.zcard.mockResolvedValue(0);
        mockRedis.zrange.mockResolvedValue([]);

        const limiterModule = await import('../../src/services/rate-limiter.js');
        rateLimiter = limiterModule.rateLimiter;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('checkRateLimit', () => {
        it('should allow requests under the limit', async () => {
            mockRedis.zcard.mockResolvedValue(5);

            const result = await rateLimiter.checkRateLimit('RSS', 'test-source');

            expect(result.allowed).toBe(true);
            expect(result.remaining).toBeGreaterThan(0);
        });

        it('should deny requests over the limit', async () => {
            mockRedis.zcard.mockResolvedValue(60);
            mockRedis.zrange.mockResolvedValue(['timestamp', String(Date.now() - 1000)]);

            const result = await rateLimiter.checkRateLimit('RSS', 'test-source');

            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
            expect(result.resetMs).toBeGreaterThan(0);
        });
    });

    describe('consumeRateLimit', () => {
        it('should record request when allowed', async () => {
            mockRedis.zcard.mockResolvedValue(5);

            await rateLimiter.consumeRateLimit('YOUTUBE', 'channel-123');

            expect(mockRedis.zadd).toHaveBeenCalled();
            expect(mockRedis.expire).toHaveBeenCalled();
        });

        it('should not record request when denied', async () => {
            mockRedis.zcard.mockResolvedValue(100);

            await rateLimiter.consumeRateLimit('YOUTUBE', 'channel-456');

            expect(mockRedis.zadd).not.toHaveBeenCalled();
        });
    });

    describe('getRateLimits', () => {
        it('should return configured rate limits', () => {
            const limits = rateLimiter.getRateLimits();

            expect(limits.RSS).toBeDefined();
            expect(limits.YOUTUBE).toBeDefined();
            expect(limits.REDDIT).toBeDefined();
            expect(limits.TWITTER).toBeDefined();
            expect(limits.ITUNES).toBeDefined();
        });

        it('should have Twitter with longer window', () => {
            const limits = rateLimiter.getRateLimits();

            // Twitter uses 1 hour window by default
            expect(limits.TWITTER.windowMs).toBeGreaterThan(limits.RSS.windowMs);
        });
    });

    describe('getRateLimitStatus', () => {
        it('should return current status', async () => {
            mockRedis.zcard.mockResolvedValue(25);

            const status = await rateLimiter.getRateLimitStatus('RSS', 'test');

            expect(status.current).toBe(25);
            expect(status.max).toBe(60);
            expect(status.remaining).toBe(35);
            expect(status.windowMs).toBe(60000);
        });
    });
});
