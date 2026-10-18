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
    createTelegramClient,
    resetTelegramClientFactoryForTest,
    setTelegramClientFactoryForTest,
    wrapTelegramMediaDownloadError,
} from '../../src/services/telegram-client.js';
import { telegramFetcher } from '../../src/fetchers/telegram.fetcher.js';
import type { TelegramSourceConfig } from '../../src/fetchers/types.js';
import { withSourceProviderIO } from '../../src/services/source-provider-io.js';

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

    it('counts pagination RPCs but not cached entity reads, with an instance-local cap', async () => {
        const invoke = vi.fn(async () => 'page');
        setTelegramClientFactoryForTest(() => ({
            invoke,
            connect: vi.fn(async () => undefined),
            disconnect: vi.fn(async () => undefined),
            getEntity: vi.fn(async () => 'cached-channel'),
            iterMessages: vi.fn(),
            getMessages: vi.fn(),
            downloadMedia: vi.fn(),
        }));
        const client = createTelegramClient();
        const started = vi.fn(async () => undefined);
        await withSourceProviderIO(1, started, () => {}, async () => {
            await client.getEntity('cached-channel');
            expect(started).not.toHaveBeenCalled();
            await expect(client.invoke!({ page: 1 })).resolves.toBe('page');
            await expect(client.invoke!({ page: 2 })).rejects.toThrow('budget exhausted');
        });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(started).toHaveBeenCalledExactlyOnceWith(1);
        // Other jobs have no source-run context and retain the normal SDK behavior.
        await expect(createTelegramClient().invoke!({ page: 2 })).resolves.toBe('page');
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('throws on transient fetch timeout so the source job is retried', async () => {
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

        await expect(telegramFetcher.fetch(source)).rejects.toThrow('telegram_timeout: TIMEOUT');
        expect(disconnect).toHaveBeenCalledOnce();
    });
});
