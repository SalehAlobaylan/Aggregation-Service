/**
 * Deduplication service using Redis
 * Prevents duplicate content processing using idempotency keys
 */
import { createHash } from 'crypto';
import { getRedisConnection } from '../queues/redis.js';
import { logger } from '../observability/logger.js';

const DEDUP_PREFIX = 'dedup:';
const CONTENT_ID_PREFIX = 'content:';
const DEFAULT_TTL = 86400; // 24 hours

/**
 * Generate an idempotency key for content
 * Priority: canonical URL > hash(title + publishedAt)
 */
export function generateIdempotencyKey(
    url?: string | null,
    title?: string | null,
    publishedAt?: string | null
): string {
    // Prefer canonical URL
    if (url) {
        return canonicalizeUrl(url);
    }

    // Fallback to hash of title + publishedAt
    if (title) {
        const data = `${title}|${publishedAt || ''}`;
        return createHash('sha256').update(data).digest('hex').substring(0, 32);
    }

    // Last resort: random key (won't dedupe)
    return createHash('sha256')
        .update(Date.now().toString() + Math.random().toString())
        .digest('hex')
        .substring(0, 32);
}

/**
 * Canonicalize URL for consistent deduplication
 */
function canonicalizeUrl(url: string): string {
    try {
        const parsed = new URL(url);
        // Remove tracking parameters
        const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'source'];
        trackingParams.forEach(param => parsed.searchParams.delete(param));
        // Remove trailing slash
        let path = parsed.pathname.replace(/\/+$/, '') || '/';
        // Lowercase hostname
        return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${path}${parsed.search}`;
    } catch {
        // If URL parsing fails, hash it
        return createHash('sha256').update(url).digest('hex').substring(0, 32);
    }
}

/**
 * Check if content has already been processed
 */
export async function isDuplicate(idempotencyKey: string): Promise<boolean> {
    const redis = getRedisConnection();
    const exists = await redis.exists(`${DEDUP_PREFIX}${idempotencyKey}`);
    return exists === 1;
}

/**
 * Mark content as processed
 */
export async function markProcessed(
    idempotencyKey: string,
    contentItemId: string,
    ttl: number = DEFAULT_TTL
): Promise<void> {
    const redis = getRedisConnection();
    const key = `${DEDUP_PREFIX}${idempotencyKey}`;
    await redis.setex(key, ttl, contentItemId);

    // Also cache the reverse mapping for quick lookups
    await redis.setex(`${CONTENT_ID_PREFIX}${idempotencyKey}`, ttl, contentItemId);

    logger.debug('Marked content as processed', { idempotencyKey, contentItemId });
}

/**
 * Get cached content item ID for an idempotency key
 */
export async function getContentItemId(idempotencyKey: string): Promise<string | null> {
    const redis = getRedisConnection();
    return redis.get(`${CONTENT_ID_PREFIX}${idempotencyKey}`);
}

/**
 * Check dedup and get existing ID if duplicate
 * Returns { isDuplicate: boolean, existingId?: string }
 */
export async function checkDedup(idempotencyKey: string): Promise<{
    isDuplicate: boolean;
    existingId?: string;
}> {
    const redis = getRedisConnection();
    const existingId = await redis.get(`${DEDUP_PREFIX}${idempotencyKey}`);

    if (existingId) {
        logger.debug('Duplicate detected', { idempotencyKey, existingId });
        return { isDuplicate: true, existingId };
    }

    return { isDuplicate: false };
}

export const dedupService = {
    generateIdempotencyKey,
    isDuplicate,
    markProcessed,
    getContentItemId,
    checkDedup,
};
