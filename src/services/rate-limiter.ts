/**
 * Rate limiter using Redis
 * Implements sliding window rate limiting per source
 */
import { getRedisConnection } from '../queues/redis.js';
import { logger } from '../observability/logger.js';
import { rateLimitHits } from '../observability/metrics.js';

const RATE_LIMIT_PREFIX = 'ratelimit:';

export interface RateLimitConfig {
    maxRequests: number;
    windowMs: number;
}

// Build rate limits from environment variables with defaults
function buildRateLimits(): Record<string, RateLimitConfig> {
    const windowMs = parseInt(process.env['RATE_LIMIT_WINDOW_MS'] || '60000');

    return {
        RSS: {
            maxRequests: parseInt(process.env['RATE_LIMIT_MAX_REQUESTS_RSS'] || '60'),
            windowMs,
        },
        YOUTUBE: {
            maxRequests: parseInt(process.env['RATE_LIMIT_MAX_REQUESTS_YOUTUBE'] || '100'),
            windowMs,
        },
        PODCAST: {
            maxRequests: parseInt(process.env['RATE_LIMIT_MAX_REQUESTS_PODCAST'] || '60'),
            windowMs,
        },
        REDDIT: {
            maxRequests: parseInt(process.env['RATE_LIMIT_MAX_REQUESTS_REDDIT'] || '60'),
            windowMs,
        },
        TWITTER: {
            maxRequests: parseInt(process.env['RATE_LIMIT_MAX_REQUESTS_TWITTER'] || '100'),
            windowMs: parseInt(process.env['RATE_LIMIT_WINDOW_MS_TWITTER'] || '3600000'), // 1 hour for scraping
        },
        ITUNES: {
            maxRequests: parseInt(process.env['RATE_LIMIT_MAX_REQUESTS_ITUNES'] || '20'),
            windowMs,
        },
    };
}

// Lazy initialization of rate limits
let _rateLimits: Record<string, RateLimitConfig> | null = null;
function getRateLimits(): Record<string, RateLimitConfig> {
    if (!_rateLimits) {
        _rateLimits = buildRateLimits();
    }
    return _rateLimits;
}

/**
 * Check if request is allowed under rate limit
 */
export async function checkRateLimit(
    sourceType: string,
    sourceId?: string
): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
    const limits = getRateLimits();
    const config = limits[sourceType] || limits.RSS;
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

        // Record metrics
        rateLimitHits.inc({ source_type: sourceType, source_id: sourceId || 'default' });

        logger.warn('Rate limit exceeded', { sourceType, sourceId, currentCount, maxRequests: config.maxRequests });
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
    const limits = getRateLimits();
    const config = limits[sourceType] || limits.RSS;
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

/**
 * Get current rate limit status (for admin inspection)
 */
export async function getRateLimitStatus(
    sourceType: string,
    sourceId?: string
): Promise<{ current: number; max: number; remaining: number; windowMs: number }> {
    const limits = getRateLimits();
    const config = limits[sourceType] || limits.RSS;
    const key = `${RATE_LIMIT_PREFIX}${sourceType}:${sourceId || 'default'}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    const redis = getRedisConnection();
    await redis.zremrangebyscore(key, '-inf', windowStart);
    const current = await redis.zcard(key);

    return {
        current,
        max: config.maxRequests,
        remaining: Math.max(0, config.maxRequests - current),
        windowMs: config.windowMs,
    };
}

export const rateLimiter = {
    checkRateLimit,
    recordRequest,
    consumeRateLimit,
    getRateLimitStatus,
    getRateLimits,
};
