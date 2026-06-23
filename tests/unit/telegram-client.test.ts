import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/index.js', () => ({
    config: {
        telegramApiId: 123,
        telegramApiHash: 'hash',
        telegramSessionString: 'session',
        logLevel: 'silent',
        nodeEnv: 'test',
    },
}));

vi.mock('../../src/observability/logger.js', () => ({
    logger: {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('../../src/services/rate-limiter.js', () => ({
    rateLimiter: {
        consumeRateLimit: vi.fn(async () => ({ allowed: true, remaining: 1, resetAt: new Date() })),
    },
}));

import {
    classifyTelegramError,
    resetTelegramClientFactoryForTest,
    setTelegramClientFactoryForTest,
    wrapTelegramMediaDownloadError,
} from '../../src/services/telegram-client.js';
import { telegramFetcher } from '../../src/fetchers/telegram.fetcher.js';
import type { TelegramSourceConfig } from '../../src/fetchers/types.js';

describe('telegram error handling', () => {
    afterEach(() => {
        resetTelegramClientFactoryForTest();
        vi.restoreAllMocks();
    });

    it('classifies GramJS timeout-like errors as transient', () => {
        const details = classifyTelegramError(new Error('TIMEOUT'));
        expect(details).toEqual({
            code: 'telegram_timeout',
            message: 'TIMEOUT',
            transient: true,
        });
    });

    it('wraps transient media download errors with a stable reason', () => {
        const wrapped = wrapTelegramMediaDownloadError(new Error('TIMEOUT'));
        expect(wrapped.message).toContain('telegram_media_download_timeout');
    });

    it('returns an empty fetch result instead of throwing on transient fetch timeout', async () => {
        const disconnect = vi.fn(async () => undefined);
        setTelegramClientFactoryForTest(() => ({
            connect: vi.fn(async () => {
                throw new Error('TIMEOUT');
            }),
            disconnect,
            getEntity: vi.fn(),
            iterMessages: vi.fn(),
            getMessages: vi.fn(),
            downloadMedia: vi.fn(),
        }));

        const source: TelegramSourceConfig = {
            id: 'telegram-source',
            type: 'TELEGRAM',
            name: 'Telegram Source',
            url: 'https://t.me/example',
            enabled: true,
            pollIntervalMs: 60_000,
            settings: { media_types: ['text'] } as unknown as TelegramSourceConfig['settings'],
        };

        const result = await telegramFetcher.fetch(source);

        expect(result.items).toEqual([]);
        expect(result.hasMore).toBe(false);
        expect(result.metadata.errors).toBe(1);
        expect(disconnect).toHaveBeenCalledOnce();
    });
});
