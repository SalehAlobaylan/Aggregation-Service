import { describe, expect, it } from 'vitest';
import { telegramNormalizer } from '../../src/normalizers/telegram.normalizer.js';

describe('telegramNormalizer', () => {
    it('normalizes Telegram audio into PODCAST content with TELEGRAM source', () => {
        const normalized = telegramNormalizer.normalize({
            externalId: 'channel:42',
            sourceType: 'TELEGRAM',
            url: 'https://t.me/channel/42',
            title: 'Daily Briefing',
            content: 'Top related for the day.',
            excerpt: 'Top related',
            author: 'Wahb News',
            publishedAt: '2026-03-07T10:00:00.000Z',
            duration: 245,
            metadata: {
                channelTitle: 'Wahb Channel',
                channelUsername: '@wahb_channel',
                messageId: 42,
                mediaKind: 'audio',
                telegramDownloadRef: {
                    channelUsername: '@wahb_channel',
                    messageId: 42,
                    mediaKind: 'audio',
                },
            },
            fetchedAt: '2026-03-07T11:00:00.000Z',
        });

        expect(normalized.type).toBe('PODCAST');
        expect(normalized.source).toBe('TELEGRAM');
        expect(normalized.status).toBe('PENDING');
        expect(normalized.mediaUrl).toBeNull();
        expect(normalized.durationSec).toBe(245);
        expect(normalized.sourceFeedUrl).toBe('https://t.me/wahb_channel');
        expect(normalized.metadata.news).toBeTruthy();
        expect(typeof (normalized.metadata.news as { likelyNews: boolean }).likelyNews).toBe('boolean');
        expect((normalized.metadata.telegramDownloadRef as { messageId: number }).messageId).toBe(42);
    });

    it('maps Telegram video to VIDEO content', () => {
        const normalized = telegramNormalizer.normalize({
            externalId: 'channel:77',
            sourceType: 'TELEGRAM',
            url: 'https://t.me/channel/77',
            title: 'Briefing Video',
            content: 'Daily global update',
            metadata: {
                channelTitle: 'Wahb Channel',
                channelUsername: '@wahb_channel',
                messageId: 77,
                mediaKind: 'video',
                telegramDownloadRef: {
                    channelUsername: '@wahb_channel',
                    messageId: 77,
                    mediaKind: 'video',
                },
            },
            fetchedAt: '2026-03-07T11:00:00.000Z',
        });

        expect(normalized.type).toBe('VIDEO');
        expect(normalized.source).toBe('TELEGRAM');
    });

    it('maps Telegram photo to ARTICLE and tags likely news', () => {
        const normalized = telegramNormalizer.normalize({
            externalId: 'channel:88',
            sourceType: 'TELEGRAM',
            url: 'https://t.me/channel/88',
            title: 'Breaking: Major update',
            content: 'Government announced emergency update',
            metadata: {
                channelTitle: 'Wahb Channel',
                channelUsername: '@wahb_channel',
                messageId: 88,
                mediaKind: 'photo',
                newsSignals: { likelyNews: true, score: 3, matchedKeywords: ['breaking', 'government', 'update'] },
                telegramDownloadRef: {
                    channelUsername: '@wahb_channel',
                    messageId: 88,
                    mediaKind: 'photo',
                },
            },
            fetchedAt: '2026-03-07T11:00:00.000Z',
        });

        expect(normalized.type).toBe('ARTICLE');
        expect(normalized.topicTags).toContain('news');
        expect((normalized.metadata.news as { likelyNews: boolean; confidence: string }).likelyNews).toBe(true);
        expect((normalized.metadata.news as { confidence: string }).confidence).toMatch(/medium|high/);
    });
});
