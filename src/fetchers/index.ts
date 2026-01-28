/**
 * Source Router / Fetcher Dispatcher
 * Routes fetch requests to the appropriate source-specific fetcher
 */
import { logger } from '../observability/logger.js';
import type { SourceType } from '../queues/schemas.js';
import type { Fetcher, FetchResult, SourceConfig } from './types.js';

import { rssFetcher } from './rss.fetcher.js';
import { youtubeFetcher } from './youtube.fetcher.js';
import { podcastFetcher } from './podcast.fetcher.js';
import { redditFetcher } from './reddit.fetcher.js';
import { twitterFetcher } from './twitter.fetcher.js';

// Register all fetchers
const fetchers: Map<SourceType, Fetcher> = new Map([
    ['RSS', rssFetcher],
    ['YOUTUBE', youtubeFetcher],
    ['PODCAST', podcastFetcher],
    ['REDDIT', redditFetcher],
    ['TWITTER', twitterFetcher],
]);

/**
 * Get fetcher for a source type
 */
export function getFetcher(sourceType: SourceType): Fetcher | undefined {
    return fetchers.get(sourceType);
}

/**
 * Fetch content from a source
 */
export async function fetchFromSource(
    config: SourceConfig,
    cursor?: string
): Promise<FetchResult> {
    const fetcher = getFetcher(config.type);

    if (!fetcher) {
        logger.error('No fetcher available for source type', {
            sourceType: config.type,
            sourceId: config.id
        });

        return {
            items: [],
            hasMore: false,
            metadata: {
                totalFetched: 0,
                skipped: 0,
                errors: 1,
            },
        };
    }

    logger.info('Routing fetch request', {
        sourceType: config.type,
        sourceId: config.id,
        hasCursor: !!cursor,
    });

    return fetcher.fetch(config, cursor);
}

/**
 * Check if a source type is supported
 */
export function isSourceTypeSupported(sourceType: SourceType): boolean {
    return fetchers.has(sourceType);
}

/**
 * Get all supported source types
 */
export function getSupportedSourceTypes(): SourceType[] {
    return Array.from(fetchers.keys());
}

// Re-export types
export * from './types.js';
