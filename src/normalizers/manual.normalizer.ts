/**
 * Manual/Upload Normalizer
 * Normalizes manual payloads to ContentItem schema
 */
import { dedupService } from '../services/dedup.service.js';
import type { RawFetchedItem } from '../fetchers/types.js';
import type { Normalizer, NormalizedItem } from './types.js';
import type { ContentType } from '../queues/schemas.js';

const DEFAULT_SOURCE_NAME = 'Manual Upload';

function coerceContentType(value?: string): ContentType {
    switch ((value || '').toUpperCase()) {
        case 'VIDEO':
        case 'PODCAST':
        case 'TWEET':
        case 'COMMENT':
        case 'ARTICLE':
            return value!.toUpperCase() as ContentType;
        default:
            return 'ARTICLE';
    }
}

export const manualNormalizer: Normalizer = {
    contentType: 'ARTICLE',
    sourceTypes: ['UPLOAD', 'MANUAL'],

    normalize(item: RawFetchedItem): NormalizedItem {
        const contentType = coerceContentType(item.metadata.contentType as string | undefined);
        const sourceName = (item.metadata.sourceName as string) || item.author || DEFAULT_SOURCE_NAME;
        const sourceFeedUrl = (item.metadata.sourceFeedUrl as string) || null;

        const mediaUrl = (item.metadata.mediaUrl as string) || null;
        const originalUrl = (item.metadata.originalUrl as string) || item.url;
        const durationSec = (item.metadata.durationSec as number) || item.duration || null;
        const topicTags = Array.isArray(item.metadata.topicTags) ? item.metadata.topicTags as string[] : [];
        const mediaReady = Boolean(item.metadata.mediaReady);

        const idempotencyKey = (item.metadata.idempotencyKey as string) ||
            dedupService.generateIdempotencyKey(originalUrl, item.title, item.publishedAt);

        const status =
            contentType === 'ARTICLE' || contentType === 'TWEET' || contentType === 'COMMENT'
                ? 'READY'
                : mediaReady
                    ? 'PROCESSING'
                    : 'PENDING';

        return {
            idempotencyKey,
            type: contentType,
            source: item.sourceType,
            status,

            title: item.title,
            bodyText: item.content || null,
            excerpt: item.excerpt || null,

            author: item.author || null,
            sourceName,
            sourceFeedUrl,

            mediaUrl,
            thumbnailUrl: item.thumbnailUrl || null,
            originalUrl,
            durationSec,

            topicTags,
            metadata: {
                ...item.metadata,
                fetchedAt: item.fetchedAt,
                manual: true,
            },

            publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
        };
    },
};
