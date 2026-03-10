/**
 * Telegram Normalizer
 * Normalizes Telegram audio/voice items to PODCAST content items.
 */
import { dedupService } from '../services/dedup.service.js';
import { classifyNewsCandidate } from '../services/news-classifier.service.js';
import type { RawFetchedItem } from '../fetchers/types.js';
import type { Normalizer, NormalizedItem } from './types.js';

export const telegramNormalizer: Normalizer = {
    contentType: 'PODCAST',
    sourceTypes: ['TELEGRAM'],

    normalize(item: RawFetchedItem): NormalizedItem {
        const idempotencyKey = dedupService.generateIdempotencyKey(
            item.url,
            item.title,
            item.publishedAt
        );

        const channelTitle = (item.metadata.channelTitle as string) || null;
        const channelUsername = (item.metadata.channelUsername as string) || null;
        const mediaKind = (item.metadata.mediaKind as string) || 'audio';
        const sourceVerified = item.metadata.sourceVerified === true;
        const newsSignals = item.metadata.newsSignals as {
            likelyNews?: boolean;
            score?: number;
            matchedKeywords?: string[];
        } | undefined;

        const sourceName = channelTitle || channelUsername || 'Telegram Channel';
        const sourceFeedUrl = channelUsername ? `https://t.me/${channelUsername.replace(/^@/, '')}` : null;
        const contentType = mapTelegramMediaKindToContentType(mediaKind);
        const publishedAt = item.publishedAt ? new Date(item.publishedAt) : null;
        const news = classifyNewsCandidate({
            title: item.title,
            excerpt: item.excerpt,
            bodyText: item.content,
            publishedAt,
            sourceName,
            sourceVerified,
            priorSignalScore: newsSignals?.score,
        });
        const topicTags: string[] = news.likelyNews
            ? ['news', ...news.categoryHints.map((category) => `news-${category}`)].slice(0, 4)
            : [];

        return {
            idempotencyKey,
            type: contentType,
            source: 'TELEGRAM',
            status: 'PENDING',

            title: item.title,
            bodyText: item.content || null,
            excerpt: item.excerpt || null,

            author: item.author || channelTitle,
            sourceName,
            sourceFeedUrl,

            // Telegram media is downloaded in the media worker.
            mediaUrl: null,
            thumbnailUrl: item.thumbnailUrl || null,
            originalUrl: item.url,
            durationSec: item.duration || null,

            topicTags,
            metadata: {
                channelTitle: item.metadata.channelTitle,
                channelUsername: item.metadata.channelUsername,
                sourceVerified,
                messageId: item.metadata.messageId,
                mediaKind: item.metadata.mediaKind,
                news,
                newsSignals,
                mimeType: item.metadata.mimeType,
                fileName: item.metadata.fileName,
                telegramDownloadRef: item.metadata.telegramDownloadRef,
                fetchedAt: item.fetchedAt,
            },
            publishedAt,
        };
    },
};

function mapTelegramMediaKindToContentType(
    mediaKind: string
): NormalizedItem['type'] {
    if (mediaKind === 'video') {
        return 'VIDEO';
    }
    if (mediaKind === 'photo') {
        return 'ARTICLE';
    }
    return 'PODCAST';
}
