/**
 * Manual/Upload Fetcher
 * Treats provided payload as already-fetched content
 */
import { logger } from '../observability/logger.js';
import type { Fetcher, FetchResult, RawFetchedItem, ManualSourceConfig, SourceConfig } from './types.js';

function buildFallbackUrl(externalId: string): string {
    return `https://manual.wahb.local/${encodeURIComponent(externalId)}`;
}

export const manualFetcher: Fetcher = {
    sourceType: 'MANUAL',

    async fetch(config: SourceConfig): Promise<FetchResult> {
        const manualConfig = config as ManualSourceConfig;
        const payload = manualConfig.settings?.payload || manualConfig.settings || {};

        if (!payload.contentType || !payload.title) {
            logger.warn('Manual fetcher missing required payload fields', {
                sourceId: config.id,
                hasContentType: !!payload.contentType,
                hasTitle: !!payload.title,
            });
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 1, errors: 1 },
            };
        }

        const externalId = payload.externalId || config.id || `manual-${Date.now()}`;
        const url = payload.originalUrl || payload.mediaUrl || config.url || buildFallbackUrl(externalId);

        const item: RawFetchedItem = {
            externalId,
            sourceType: config.type,
            url,
            title: payload.title,
            content: payload.bodyText || undefined,
            excerpt: payload.excerpt || undefined,
            author: payload.author || undefined,
            publishedAt: payload.publishedAt,
            thumbnailUrl: payload.thumbnailUrl || undefined,
            duration: payload.durationSec,
            metadata: {
                contentType: payload.contentType,
                sourceName: payload.sourceName,
                sourceFeedUrl: payload.sourceFeedUrl,
                mediaUrl: payload.mediaUrl,
                originalUrl: payload.originalUrl,
                topicTags: payload.topicTags,
                idempotencyKey: payload.idempotencyKey,
                mediaReady: payload.mediaReady,
                ...payload.metadata,
            },
            fetchedAt: new Date().toISOString(),
        };

        logger.info('Manual fetcher created item', {
            sourceId: config.id,
            contentType: payload.contentType,
            externalId,
        });

        return {
            items: [item],
            hasMore: false,
            metadata: { totalFetched: 1, skipped: 0, errors: 0 },
        };
    },
};
