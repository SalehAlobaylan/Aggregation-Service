/**
 * Video Normalizer
 * Normalizes YouTube videos to ContentItem schema
 */
import { dedupService } from '../services/dedup.service.js';
import type { RawFetchedItem } from '../fetchers/types.js';
import type { Normalizer, NormalizedItem } from './types.js';

export const videoNormalizer: Normalizer = {
    contentType: 'VIDEO',
    sourceTypes: ['YOUTUBE'],

    normalize(item: RawFetchedItem): NormalizedItem {
        // Generate idempotency key using YouTube video URL
        const idempotencyKey = dedupService.generateIdempotencyKey(
            item.url,
            item.title,
            item.publishedAt
        );

        // Source name is the channel title
        const sourceName = (item.metadata.channelTitle as string) ||
            item.author ||
            'Unknown Channel';

        return {
            idempotencyKey,
            type: 'VIDEO',
            source: 'YOUTUBE',
            status: 'PENDING', // Videos need Phase 3 media processing

            title: item.title,
            bodyText: item.content || null, // Video description
            excerpt: item.excerpt || null,

            author: item.author || null, // Channel name
            sourceName,
            sourceFeedUrl: null, // YouTube doesn't use feeds

            mediaUrl: null, // Will be set in Phase 3 after processing
            thumbnailUrl: item.thumbnailUrl || null,
            originalUrl: item.url,
            durationSec: item.duration || null,

            topicTags: extractTags(item),
            metadata: {
                videoId: item.metadata.videoId,
                channelId: item.metadata.channelId,
                channelTitle: item.metadata.channelTitle,
                playlistId: item.metadata.playlistId,
                tags: item.metadata.tags,
                categoryId: item.metadata.categoryId,
                fetchedAt: item.fetchedAt,
            },

            publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
        };
    },
};

/**
 * Extract topic tags from YouTube metadata
 */
function extractTags(item: RawFetchedItem): string[] {
    const tags: string[] = [];

    // From YouTube tags
    if (Array.isArray(item.metadata.tags)) {
        tags.push(...item.metadata.tags.filter((t): t is string => typeof t === 'string'));
    }

    // Limit to reasonable number
    return tags.slice(0, 10);
}
