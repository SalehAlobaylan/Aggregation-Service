import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';

export interface TelegramClientLike {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    getEntity(entity: string): Promise<unknown>;
    iterMessages(entity: unknown, opts: Record<string, unknown>): AsyncIterable<unknown>;
    getMessages(entity: string, opts: { ids: number[] }): Promise<unknown[]>;
    downloadMedia(message: unknown): Promise<unknown>;
}

type TelegramClientFactory = () => TelegramClientLike;

function buildDefaultTelegramClient(): TelegramClientLike {
    return new TelegramClient(
        new StringSession(config.telegramSessionString ?? ''),
        config.telegramApiId ?? 0,
        config.telegramApiHash ?? '',
        {
            connectionRetries: 2,
            requestRetries: 1,
            retryDelay: 1000,
        } as ConstructorParameters<typeof TelegramClient>[3]
    ) as unknown as TelegramClientLike;
}

let factory: TelegramClientFactory = buildDefaultTelegramClient;

export function createTelegramClient(): TelegramClientLike {
    return factory();
}

export function setTelegramClientFactoryForTest(nextFactory: TelegramClientFactory): void {
    factory = nextFactory;
}

export function resetTelegramClientFactoryForTest(): void {
    factory = buildDefaultTelegramClient;
}

export interface TelegramErrorDetails {
    code: string;
    message: string;
    transient: boolean;
}

export function classifyTelegramError(error: unknown): TelegramErrorDetails {
    const anyErr = error as { code?: string; name?: string; message?: string; seconds?: number };
    const message = anyErr?.message || String(error);
    const haystack = `${anyErr?.code ?? ''} ${anyErr?.name ?? ''} ${message}`.toLowerCase();

    if (haystack.includes('flood') || typeof anyErr?.seconds === 'number') {
        return { code: 'telegram_flood_wait', message, transient: true };
    }
    if (haystack.includes('timeout') || haystack.includes('timed out')) {
        return { code: 'telegram_timeout', message, transient: true };
    }
    if (
        haystack.includes('econnreset') ||
        haystack.includes('etimedout') ||
        haystack.includes('socket hang up') ||
        haystack.includes('connection closed') ||
        haystack.includes('network')
    ) {
        return { code: 'telegram_connection_transient', message, transient: true };
    }

    return { code: 'telegram_error', message, transient: false };
}

export function wrapTelegramMediaDownloadError(error: unknown): Error {
    const details = classifyTelegramError(error);
    if (!details.transient) {
        return error instanceof Error ? error : new Error(details.message);
    }
    const wrapped = new Error(`telegram_media_download_timeout: ${details.message}`);
    wrapped.cause = error;
    return wrapped;
}

export async function disconnectTelegramClient(
    client: TelegramClientLike,
    context?: Record<string, unknown>
): Promise<void> {
    try {
        await client.disconnect();
    } catch (error) {
        logger.warn('Telegram disconnect failed', {
            ...(context ?? {}),
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
