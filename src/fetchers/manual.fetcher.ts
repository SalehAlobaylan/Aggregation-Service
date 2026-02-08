/**
 * Manual/Upload Fetcher
 * Treats provided payload as already-fetched content
 */
import { logger } from '../observability/logger.js';
import type { Fetcher, FetchResult, RawFetchedItem, ManualPayload, ManualSourceConfig, SourceConfig } from './types.js';

function buildFallbackUrl(externalId: string): string {
    return `https://manual.wahb.local/${encodeURIComponent(externalId)}`;
}

export const manualFetcher: Fetcher = {
    sourceType: 'MANUAL',

    async fetch(config: SourceConfig): Promise<FetchResult> {
        const manualConfig = config as ManualSourceConfig;
        const payload: ManualPayload = manualConfig.settings?.payload || {} as ManualPayload;

        if (!payload.contentType || !payload.title) {
            logger.warn('Manual fetcher missing required payload fields', {
                sourceId: config.id,
                hasContentType: !!(payload as ManualPayload).contentType,
                hasTitle: !!(payload as ManualPayload).title,
            });
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 1, errors: 1 },
            };
        }

        if (!payload.contentType || !payload.title) {
            logger.warn('Manual fetcher missing required payload fields', {
                sourceId: config.id,
                hasContentType: !!(payload as ManualPayload).contentType,
                hasTitle: !!(payload as ManualPayload).title,
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
            title: (payload as ManualPayload).title,
            content: (payload as ManualPayload).bodyText || undefined,
            excerpt: (payload as ManualPayload).excerpt || undefined,
            author: (payload as ManualPayload).author || undefined,
            publishedAt: (payload as ManualPayload).publishedAt,
            thumbnailUrl: (payload as ManualPayload).thumbnailUrl || undefined,
            duration: (payload as ManualPayload).durationSec,
            metadata: {
                contentType: (payload as ManualPayload).contentType,
                sourceName: (payload as ManualPayload).sourceName,
                sourceFeedUrl: (payload as ManualPayload).sourceFeedUrl,
                mediaUrl: (payload as ManualPayload).mediaUrl,
                originalUrl: (payload as ManualPayload).originalUrl,
                topicTags: (payload as ManualPayload).topicTags,
                idempotencyKey: (payload as ManualPayload).idempotencyKey,
                mediaReady: (payload as ManualPayload).mediaReady,
                ...(payload as ManualPayload).metadata,
            },
            fetchedAt: new Date().toISOString(),
        };

        logger.info('Manual fetcher created item', {
            sourceId: config.id,
            contentType: (payload as ManualPayload).contentType,
            externalId,
        });

        return {
            items: [item],
            hasMore: false,
            metadata: { totalFetched: 1, skipped: 0, errors: 0 },
        };
    },
};
