/**
 * Rate limiter using Redis
 * Implements sliding window rate limiting per source
 */
import { getRedisConnection } from '../queues/redis.js';
import { logger } from '../observability/logger.js';

const RATE_LIMIT_PREFIX = 'ratelimit:';

export interface RateLimitConfig {
    maxRequests: number;
    windowMs: number;
}

// Default rate limits per source type
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
    RSS: { maxRequests: 60, windowMs: 60000 },         // 60/min
    YOUTUBE: { maxRequests: 100, windowMs: 60000 },   // 100/min (API quota managed separately)
    PODCAST: { maxRequests: 60, windowMs: 60000 },    // 60/min
    REDDIT: { maxRequests: 60, windowMs: 60000 },     // 60/min (OAuth limit)
    TWITTER: { maxRequests: 100, windowMs: 3600000 }, // 100/hour (conservative scraping)
};

/**
 * Check if request is allowed under rate limit
 */
export async function checkRateLimit(
    sourceType: string,
    sourceId?: string
): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
    const config = DEFAULT_RATE_LIMITS[sourceType] || DEFAULT_RATE_LIMITS.RSS;
    const key = `${RATE_LIMIT_PREFIX}${sourceType}:${sourceId || 'default'}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    const redis = getRedisConnection();

    // Remove old entries outside the window
    await redis.zremrangebyscore(key, '-inf', windowStart);

    // Count current requests in window
    const currentCount = await redis.zcard(key);

    if (currentCount >= config.maxRequests) {
        // Get oldest entry to calculate reset time
        const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
        const resetMs = oldest.length >= 2
            ? parseInt(oldest[1]) + config.windowMs - now
            : config.windowMs;

        logger.warn('Rate limit exceeded', { sourceType, sourceId, currentCount });
        return { allowed: false, remaining: 0, resetMs };
    }

    return {
        allowed: true,
        remaining: config.maxRequests - currentCount - 1,
        resetMs: config.windowMs
    };
}

/**
 * Record a request for rate limiting
 */
export async function recordRequest(
    sourceType: string,
    sourceId?: string
): Promise<void> {
    const config = DEFAULT_RATE_LIMITS[sourceType] || DEFAULT_RATE_LIMITS.RSS;
    const key = `${RATE_LIMIT_PREFIX}${sourceType}:${sourceId || 'default'}`;
    const now = Date.now();

    const redis = getRedisConnection();

    // Add current request timestamp
    await redis.zadd(key, now, `${now}:${Math.random()}`);

    // Set expiry on the key (cleanup)
    await redis.expire(key, Math.ceil(config.windowMs / 1000) + 60);
}

/**
 * Check and record in one operation
 */
export async function consumeRateLimit(
    sourceType: string,
    sourceId?: string
): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
    const result = await checkRateLimit(sourceType, sourceId);

    if (result.allowed) {
        await recordRequest(sourceType, sourceId);
    }

    return result;
}

export const rateLimiter = {
    checkRateLimit,
    recordRequest,
    consumeRateLimit,
    DEFAULT_RATE_LIMITS,
};
