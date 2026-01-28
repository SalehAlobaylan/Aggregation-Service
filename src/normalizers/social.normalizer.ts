/**
 * Social Content Normalizer
 * Normalizes Reddit and Twitter content to ContentItem schema
 */
import { dedupService } from '../services/dedup.service.js';
import type { RawFetchedItem } from '../fetchers/types.js';
import type { Normalizer, NormalizedItem } from './types.js';
import type { ContentType, SourceType } from '../queues/schemas.js';

export const socialNormalizer: Normalizer = {
    contentType: 'COMMENT', // Default, but will be determined by source
    sourceTypes: ['REDDIT', 'TWITTER'],

    normalize(item: RawFetchedItem): NormalizedItem {
        // Generate idempotency key
        const idempotencyKey = dedupService.generateIdempotencyKey(
            item.url,
            item.title,
            item.publishedAt
        );

        // Determine content type based on source
        let contentType: ContentType = 'COMMENT';
        let source: SourceType = item.sourceType;
        let sourceName = 'Unknown';

        if (item.sourceType === 'TWITTER') {
            contentType = 'TWEET';
            sourceName = (item.metadata.authorUsername as string) || item.author || 'Twitter';
        } else if (item.sourceType === 'REDDIT') {
            contentType = 'COMMENT';
            sourceName = `r/${item.metadata.subreddit as string}` || 'Reddit';
        }

        // Build engagement metadata
        const engagementMetadata: Record<string, unknown> = {};
        if (item.engagement) {
            engagementMetadata.likes = item.engagement.likes;
            engagementMetadata.shares = item.engagement.shares;
            engagementMetadata.comments = item.engagement.comments;
            engagementMetadata.views = item.engagement.views;
            engagementMetadata.score = item.engagement.score;
        }

        return {
            idempotencyKey,
            type: contentType,
            source,
            status: 'READY', // Social content is text-only, ready immediately

            title: item.title.substring(0, 255), // Limit title length
            bodyText: item.content || null,
            excerpt: item.excerpt || null,

            author: item.author || null,
            sourceName,
            sourceFeedUrl: null,

            mediaUrl: null,
            thumbnailUrl: item.thumbnailUrl || null,
            originalUrl: item.url,
            durationSec: null,

            topicTags: extractTags(item),
            metadata: {
                ...item.metadata,
                engagement: engagementMetadata,
                fetchedAt: item.fetchedAt,
            },

            publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
        };
    },
};

/**
 * Extract topic tags from social content
 */
function extractTags(item: RawFetchedItem): string[] {
    const tags: string[] = [];

    // From Reddit flair
    if (item.metadata.flairText) {
        tags.push(item.metadata.flairText as string);
    }

    // From Reddit subreddit
    if (item.metadata.subreddit) {
        tags.push(item.metadata.subreddit as string);
    }

    // Extract hashtags from Twitter content
    if (item.sourceType === 'TWITTER' && item.content) {
        const hashtags = item.content.match(/#\w+/g);
        if (hashtags) {
            tags.push(...hashtags.map(h => h.substring(1)));
        }
    }

    // Limit to reasonable number
    return [...new Set(tags)].slice(0, 10);
}
