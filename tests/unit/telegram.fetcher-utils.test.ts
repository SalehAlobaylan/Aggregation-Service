import { describe, expect, it } from 'vitest';
import { telegramFetcherTestUtils } from '../../src/fetchers/telegram.fetcher.js';
import type { TelegramSourceConfig } from '../../src/fetchers/types.js';

describe('telegramFetcherTestUtils', () => {
    it('normalizes channel URL and username formats', () => {
        expect(telegramFetcherTestUtils.normalizeTelegramChannel('@wahb_channel')).toBe('@wahb_channel');
        expect(telegramFetcherTestUtils.normalizeTelegramChannel('wahb_channel')).toBe('@wahb_channel');
        expect(telegramFetcherTestUtils.normalizeTelegramChannel('https://t.me/wahb_channel')).toBe('@wahb_channel');
        expect(telegramFetcherTestUtils.normalizeTelegramChannel('http://telegram.me/wahb_channel')).toBe('@wahb_channel');
        expect(telegramFetcherTestUtils.normalizeTelegramChannel('https://t.me/s/wahb_channel')).toBe('@wahb_channel');
    });

    it('supports snake_case settings from api_config', () => {
        const sourceConfig: TelegramSourceConfig = {
            id: 'telegram-source-1',
            type: 'TELEGRAM',
            name: 'Wahb Telegram',
            url: 'https://t.me/wahb_channel',
            enabled: true,
            pollIntervalMs: 1000,
            settings: {
                channel_username: 'wahb_overrides',
                min_duration_sec: 180,
                max_duration_sec: 900,
                media_types: ['voice', 'video', 'photo'],
                max_results: 25,
            } as unknown as TelegramSourceConfig['settings'],
        };

        const parsed = telegramFetcherTestUtils.parseTelegramSettings(sourceConfig);
        expect(parsed.channelUsername).toBe('@wahb_overrides');
        expect(parsed.minDurationSec).toBe(270);
        expect(parsed.maxDurationSec).toBe(900);
        expect(parsed.mediaTypes).toEqual(['voice', 'video', 'photo']);
        expect(parsed.maxResults).toBe(25);
    });

    it('overfetches a bounded candidate window so short media cannot consume the accepted-item cap', () => {
        expect(telegramFetcherTestUtils.telegramCandidateLimit(25)).toBe(100);
        expect(telegramFetcherTestUtils.telegramCandidateLimit(100)).toBe(200);
    });
});
