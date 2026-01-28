/**
 * Podcast Normalizer
 * Normalizes podcast episodes to ContentItem schema
 */
import { dedupService } from '../services/dedup.service.js';
import type { RawFetchedItem } from '../fetchers/types.js';
import type { Normalizer, NormalizedItem } from './types.js';

export const podcastNormalizer: Normalizer = {
    contentType: 'PODCAST',
    sourceTypes: ['PODCAST'],

    normalize(item: RawFetchedItem): NormalizedItem {
        // Generate idempotency key - prefer enclosure URL for podcasts
        const enclosureUrl = item.metadata.enclosureUrl as string | undefined;
        const idempotencyKey = dedupService.generateIdempotencyKey(
            enclosureUrl || item.url,
            item.title,
            item.publishedAt
        );

        // Source name is the show name
        const sourceName = (item.metadata.showName as string) || 'Unknown Podcast';

        return {
            idempotencyKey,
            type: 'PODCAST',
            source: 'PODCAST',
            status: 'PENDING', // Podcasts need Phase 3 media processing

            title: item.title,
            bodyText: item.content || null, // Episode description
            excerpt: item.excerpt || null,

            author: item.author || null, // Episode/show author
            sourceName,
            sourceFeedUrl: (item.metadata.feedUrl as string) || null,

            mediaUrl: enclosureUrl || null, // Audio file URL
            thumbnailUrl: item.thumbnailUrl || null,
            originalUrl: item.url,
            durationSec: item.duration || null,

            topicTags: [],
            metadata: {
                showName: item.metadata.showName,
                showUrl: item.metadata.showUrl,
                feedUrl: item.metadata.feedUrl,
                enclosureType: item.metadata.enclosureType,
                enclosureLength: item.metadata.enclosureLength,
                episodeNumber: item.metadata.episodeNumber,
                seasonNumber: item.metadata.seasonNumber,
                explicit: item.metadata.explicit,
                guid: item.metadata.guid,
                fetchedAt: item.fetchedAt,
            },

            publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
        };
    },
};
