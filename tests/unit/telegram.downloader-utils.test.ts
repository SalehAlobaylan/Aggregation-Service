import { describe, expect, it } from 'vitest';
import { downloaderTestUtils } from '../../src/media/downloader.js';

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
