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
import { itunesFetcher } from './itunes.fetcher.js';
import { redditFetcher } from './reddit.fetcher.js';
import { twitterFetcher } from './twitter.fetcher.js';
import { manualFetcher } from './manual.fetcher.js';
import { websiteFetcher } from './website.fetcher.js';

// Register all fetchers
const fetchers: Map<SourceType, Fetcher> = new Map([
    ['RSS', rssFetcher],
    ['WEBSITE', websiteFetcher],
    ['YOUTUBE', youtubeFetcher],
    ['PODCAST', podcastFetcher],
    ['PODCAST_DISCOVERY', itunesFetcher],
    ['REDDIT', redditFetcher],
    ['TWITTER', twitterFetcher],
    ['UPLOAD', manualFetcher],
    ['MANUAL', manualFetcher],
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
