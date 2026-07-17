import { describe, expect, it, vi } from 'vitest';

const { safeFetchResponseMock } = vi.hoisted(() => ({
    safeFetchResponseMock: vi.fn(),
}));

vi.mock('../../src/utils/safe-fetch.js', () => ({
    assertPublicUrl: vi.fn(),
    safeFetchResponse: safeFetchResponseMock,
}));

import { downloaderTestUtils, downloadHttp } from '../../src/media/downloader.js';

describe('downloaderTestUtils', () => {
    it('normalizes Telegram channel references consistently', () => {
        expect(downloaderTestUtils.normalizeTelegramChannel('@wahb')).toBe('@wahb');
        expect(downloaderTestUtils.normalizeTelegramChannel('wahb')).toBe('@wahb');
        expect(downloaderTestUtils.normalizeTelegramChannel('https://t.me/wahb')).toBe('@wahb');
        expect(downloaderTestUtils.normalizeTelegramChannel('https://t.me/s/wahb')).toBe('@wahb');
        expect(downloaderTestUtils.normalizeTelegramChannel('http://telegram.me/wahb')).toBe('@wahb');
    });

    it('infers Telegram extension from metadata', () => {
        expect(
            downloaderTestUtils.inferTelegramExtension({
                channelUsername: '@wahb',
                messageId: 1,
                mediaKind: 'audio',
                fileName: 'briefing.m4a',
            })
        ).toBe('m4a');

        expect(
            downloaderTestUtils.inferTelegramExtension({
                channelUsername: '@wahb',
                messageId: 2,
                mediaKind: 'voice',
                mimeType: 'audio/ogg',
            })
        ).toBe('ogg');

        expect(
            downloaderTestUtils.inferTelegramExtension({
                channelUsername: '@wahb',
                messageId: 3,
                mediaKind: 'video',
                mimeType: 'video/mp4',
            })
        ).toBe('mp4');

        expect(
            downloaderTestUtils.inferTelegramExtension({
                channelUsername: '@wahb',
                messageId: 4,
                mediaKind: 'photo',
                fileName: 'photo.png',
            })
        ).toBe('png');
    });
});

describe('downloadHttp content-type guard', () => {
    it('rejects an HTML response before writing a garbage media file', async () => {
        safeFetchResponseMock.mockResolvedValueOnce({
            response: {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
            },
            close: vi.fn().mockResolvedValue(undefined),
        });

        await expect(
            downloadHttp('https://sa.investing.com/news/article-93CH-3283147', 'c1', 'mp4')
        ).rejects.toThrow(/non-media content-type/);
    });
});
