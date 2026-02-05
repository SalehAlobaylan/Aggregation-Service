/**
 * iTunes Search API Client
 * Provides podcast discovery via Apple's iTunes Search API
 * Phase 2 (P1): Optional feature for podcast discovery
 */
import { logger } from '../observability/logger.js';
import { rateLimiter } from './rate-limiter.js';
import { getRedisConnection } from '../queues/redis.js';

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const CACHE_PREFIX = 'itunes:search:';
const CACHE_TTL = 3600; // 1 hour

export interface ItunesPodcast {
    collectionId: number;
    collectionName: string;
    artistName: string;
    feedUrl: string;
    artworkUrl600?: string;
    genres: string[];
    releaseDate: string;
    trackCount: number;
}

export interface ItunesSearchResult {
    query: string;
    results: ItunesPodcast[];
    cached: boolean;
}

/**
 * Check if iTunes Search feature is enabled
 */
export function isItunesSearchEnabled(): boolean {
    return process.env['ENABLE_ITUNES_SEARCH'] !== 'false';
}

/**
 * Search for podcasts via iTunes Search API
 * @param term Search term
 * @param limit Maximum results (max 200)
 * @param country Country code (default: US)
 */
export async function searchPodcasts(
    term: string,
    limit: number = 25,
    country: string = 'US'
): Promise<ItunesSearchResult> {
    if (!isItunesSearchEnabled()) {
        logger.warn('iTunes Search is disabled');
        return { query: term, results: [], cached: false };
    }

    // Check cache first
    const redis = getRedisConnection();
    const cacheKey = `${CACHE_PREFIX}${country}:${term.toLowerCase()}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
        logger.debug('iTunes search cache hit', { term });
        return { query: term, results: JSON.parse(cached), cached: true };
    }

    // Check rate limit
    const rateCheck = await rateLimiter.consumeRateLimit('ITUNES', 'search');
    if (!rateCheck.allowed) {
        logger.warn('iTunes rate limit exceeded', { resetMs: rateCheck.resetMs });
        return { query: term, results: [], cached: false };
    }

    try {
        const url = new URL(ITUNES_SEARCH_URL);
        url.searchParams.set('term', term);
        url.searchParams.set('media', 'podcast');
        url.searchParams.set('entity', 'podcast');
        url.searchParams.set('limit', Math.min(limit, 200).toString());
        url.searchParams.set('country', country);

        const response = await fetch(url.toString(), {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'WahbBot/1.0',
            },
        });

        if (!response.ok) {
            throw new Error(`iTunes API error: ${response.status}`);
        }

        const data = await response.json();
        const results: ItunesPodcast[] = [];

        for (const item of data.results || []) {
            // Only include items with a feed URL
            if (!item.feedUrl) continue;

            results.push({
                collectionId: item.collectionId,
                collectionName: item.collectionName,
                artistName: item.artistName,
                feedUrl: item.feedUrl,
                artworkUrl600: item.artworkUrl600,
                genres: item.genres || [],
                releaseDate: item.releaseDate,
                trackCount: item.trackCount || 0,
            });
        }

        // Cache results
        await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(results));

        logger.info('iTunes search completed', { term, resultCount: results.length });

        return { query: term, results, cached: false };
    } catch (error) {
        logger.error('iTunes search failed', error, { term });
        throw error;
    }
}

/**
 * Get podcast details by collection ID
 */
export async function lookupPodcast(collectionId: number): Promise<ItunesPodcast | null> {
    if (!isItunesSearchEnabled()) {
        return null;
    }

    // Check rate limit
    const rateCheck = await rateLimiter.consumeRateLimit('ITUNES', 'lookup');
    if (!rateCheck.allowed) {
        return null;
    }

    try {
        const url = `https://itunes.apple.com/lookup?id=${collectionId}&entity=podcast`;

        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'WahbBot/1.0',
            },
        });

        if (!response.ok) {
            throw new Error(`iTunes lookup error: ${response.status}`);
        }

        const data = await response.json();
        const item = data.results?.[0];

        if (!item || !item.feedUrl) {
            return null;
        }

        return {
            collectionId: item.collectionId,
            collectionName: item.collectionName,
            artistName: item.artistName,
            feedUrl: item.feedUrl,
            artworkUrl600: item.artworkUrl600,
            genres: item.genres || [],
            releaseDate: item.releaseDate,
            trackCount: item.trackCount || 0,
        };
    } catch (error) {
        logger.error('iTunes lookup failed', error, { collectionId });
        return null;
    }
}

export const itunesSearch = {
    isEnabled: isItunesSearchEnabled,
    searchPodcasts,
    lookupPodcast,
};
