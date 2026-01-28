/**
 * Article Normalizer
 * Normalizes RSS articles to ContentItem schema
 */
import { dedupService } from '../services/dedup.service.js';
import type { RawFetchedItem } from '../fetchers/types.js';
import type { Normalizer, NormalizedItem } from './types.js';

export const articleNormalizer: Normalizer = {
    contentType: 'ARTICLE',
    sourceTypes: ['RSS'],

    normalize(item: RawFetchedItem): NormalizedItem {
        // Generate idempotency key
        const idempotencyKey = dedupService.generateIdempotencyKey(
            item.url,
            item.title,
            item.publishedAt
        );

        // Extract domain from URL for source name
        let sourceName = 'Unknown';
        try {
            const url = new URL(item.url);
            sourceName = url.hostname.replace(/^www\./, '');
        } catch {
            // Use metadata if URL parsing fails
            sourceName = (item.metadata.feedTitle as string) || 'Unknown';
        }

        return {
            idempotencyKey,
            type: 'ARTICLE',
            source: 'RSS',
            status: 'READY', // Articles are ready once we have text

            title: item.title,
            bodyText: item.content || null,
            excerpt: item.excerpt || null,

            author: item.author || null,
            sourceName,
            sourceFeedUrl: (item.metadata.feedUrl as string) || null,

            mediaUrl: null, // Articles don't have primary media
            thumbnailUrl: item.thumbnailUrl || null,
            originalUrl: item.url,
            durationSec: null,

            topicTags: extractTags(item),
            metadata: {
                ...item.metadata,
                fetchedAt: item.fetchedAt,
            },

            publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
        };
    },
};

/**
 * Extract topic tags from item metadata
 */
function extractTags(item: RawFetchedItem): string[] {
    const tags: string[] = [];

    // From RSS categories
    if (Array.isArray(item.metadata.categories)) {
        tags.push(...item.metadata.categories.filter((t): t is string => typeof t === 'string'));
    }

    // Limit to reasonable number
    return tags.slice(0, 10);
}
