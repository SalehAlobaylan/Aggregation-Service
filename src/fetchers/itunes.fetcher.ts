/**
 * iTunes Podcast Discovery Fetcher
 * Searches iTunes and enqueues podcast RSS fetch jobs
 */
import { logger } from '../observability/logger.js';
import { itunesSearch } from '../services/itunes-search.js';
import { getQueue, QUEUE_NAMES } from '../queues/index.js';
import type { Fetcher, FetchResult, ItunesDiscoverySourceConfig, SourceConfig } from './types.js';
import type { FetchJob } from '../queues/schemas.js';

export const itunesFetcher: Fetcher = {
    sourceType: 'PODCAST_DISCOVERY',

    async fetch(config: SourceConfig): Promise<FetchResult> {
        const discoveryConfig = config as ItunesDiscoverySourceConfig;
        const { searchTerm, term, category, limit, country } = discoveryConfig.settings || {};
        const query = searchTerm || term || category;

        if (!query) {
            logger.warn('iTunes discovery requires searchTerm or category', { sourceId: config.id });
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 1, errors: 1 },
            };
        }

        if (!itunesSearch.isEnabled()) {
            logger.warn('iTunes search disabled, skipping discovery', { sourceId: config.id });
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 0, errors: 0 },
            };
        }

        const result = await itunesSearch.searchPodcasts(query, limit || 25, country || 'US');
        const fetchQueue = getQueue(QUEUE_NAMES.FETCH);

        if (!fetchQueue) {
            logger.error('Fetch queue not initialized for iTunes discovery');
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 0, errors: 1 },
            };
        }

        let enqueued = 0;

        for (const podcast of result.results) {
            if (!podcast.feedUrl) continue;

            const job: FetchJob = {
                sourceId: `itunes-${podcast.collectionId}`,
                sourceType: 'PODCAST',
                config: {
                    name: podcast.collectionName,
                    url: podcast.feedUrl,
                    settings: {},
                },
                triggeredBy: 'schedule',
                triggeredAt: new Date().toISOString(),
            };

            await fetchQueue.add(
                `itunes-podcast-${podcast.collectionId}`,
                job,
                {
                    jobId: `itunes-podcast-${podcast.collectionId}`,
                    priority: 4,
                    removeOnComplete: { age: 3600, count: 1000 },
                }
            );

            enqueued++;
        }

        logger.info('iTunes discovery enqueued podcast feeds', {
            sourceId: config.id,
            query,
            totalResults: result.results.length,
            enqueued,
            cached: result.cached,
        });

        return {
            items: [],
            hasMore: false,
            metadata: {
                totalFetched: enqueued,
                skipped: result.results.length - enqueued,
                errors: 0,
            },
        };
    },
};
