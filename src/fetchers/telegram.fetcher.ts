/**
 * Telegram Fetcher
 * Fetches audio/voice messages from public Telegram channels.
 */
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { rateLimiter } from '../services/rate-limiter.js';
import type {
    Fetcher,
    FetchResult,
    RawFetchedItem,
    SourceConfig,
    TelegramMediaType,
    TelegramSourceConfig,
} from './types.js';

const DEFAULT_MIN_DURATION_SEC = 120;
const DEFAULT_MAX_RESULTS = 50;

interface ParsedTelegramSettings {
    channelUsername: string;
    minDurationSec: number;
    maxDurationSec?: number;
    mediaTypes: TelegramMediaType[];
    maxResults: number;
}

type TelegramSettingsInput = Record<string, unknown>;

export const telegramFetcher: Fetcher = {
    sourceType: 'TELEGRAM',

    async fetch(configInput: SourceConfig, cursor?: string): Promise<FetchResult> {
        const telegramConfig = configInput as TelegramSourceConfig;
        const settings = parseTelegramSettings(telegramConfig);

        if (!config.telegramApiId || !config.telegramApiHash || !config.telegramSessionString) {
            throw new Error('Telegram is not configured. TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_SESSION_STRING are required');
        }

        const rateCheck = await rateLimiter.consumeRateLimit('TELEGRAM', configInput.id);
        if (!rateCheck.allowed) {
            logger.warn('Telegram rate limit exceeded', { sourceId: configInput.id });
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 0, errors: 0 },
            };
        }

        const client = new TelegramClient(
            new StringSession(config.telegramSessionString),
            config.telegramApiId,
            config.telegramApiHash,
            { connectionRetries: 3 }
        );

        const items: RawFetchedItem[] = [];
        let skipped = 0;
        let errors = 0;
        let lastMessageId: number | undefined;
        let scannedMessages = 0;
        const parsedOffset = cursor ? parseInt(cursor, 10) : undefined;
        const offsetId = Number.isFinite(parsedOffset) && parsedOffset && parsedOffset > 0
            ? parsedOffset
            : undefined;

        try {
            await client.connect();

            const entity = await client.getEntity(settings.channelUsername);
            const channelTitle = getChannelTitle(entity);
            const publicChannel = settings.channelUsername.replace(/^@/, '');
            const sourceVerified = isEntityVerified(entity);

            for await (const message of client.iterMessages(entity, {
                limit: settings.maxResults,
                offsetId,
            })) {
                try {
                    if (!message?.id) {
                        skipped++;
                        continue;
                    }
                    scannedMessages++;

                    const extracted = extractTelegramAudio(message);
                    if (!extracted) {
                        skipped++;
                        continue;
                    }

                    if (!settings.mediaTypes.includes(extracted.mediaKind)) {
                        skipped++;
                        continue;
                    }

                    const durationSec = extracted.durationSec;
                    const appliesDurationFilter = extracted.mediaKind !== 'photo';
                    if (appliesDurationFilter && (!durationSec || durationSec < settings.minDurationSec)) {
                        skipped++;
                        continue;
                    }
                    if (
                        appliesDurationFilter &&
                        typeof settings.maxDurationSec === 'number' &&
                        durationSec &&
                        durationSec > settings.maxDurationSec
                    ) {
                        skipped++;
                        continue;
                    }

                    lastMessageId = message.id;
                    const title = extracted.title || message.message || `Telegram ${extracted.mediaKind} ${message.id}`;
                    const description = message.message || '';
                    const rawDate = message.date as unknown;
                    const publishedAt = rawDate instanceof Date
                        ? rawDate.toISOString()
                        : undefined;
                    const originalUrl = `https://t.me/${publicChannel}/${message.id}`;

                    const item: RawFetchedItem = {
                        externalId: `${publicChannel}:${message.id}`,
                        sourceType: 'TELEGRAM',
                        url: originalUrl,
                        title,
                        content: description,
                        excerpt: description.substring(0, 300),
                        author: extracted.author || channelTitle,
                        publishedAt,
                        duration: durationSec,
                        metadata: {
                            channelUsername: settings.channelUsername,
                            channelTitle,
                            sourceVerified,
                            messageId: message.id,
                            mediaKind: extracted.mediaKind,
                            mimeType: extracted.mimeType,
                            fileName: extracted.fileName,
                            newsSignals: inferNewsSignals({
                                title,
                                text: description,
                            }),
                            telegramDownloadRef: {
                                channelUsername: settings.channelUsername,
                                channelId: getEntityId(entity),
                                messageId: message.id,
                                mediaKind: extracted.mediaKind,
                                fileName: extracted.fileName,
                                mimeType: extracted.mimeType,
                            },
                        },
                        fetchedAt: new Date().toISOString(),
                    };

                    items.push(item);
                } catch (error) {
                    errors++;
                    logger.error('Failed to process Telegram message', error, {
                        sourceId: configInput.id,
                    });
                }
            }

            return {
                items,
                cursor: lastMessageId ? String(lastMessageId) : undefined,
                hasMore: scannedMessages >= settings.maxResults && !!lastMessageId,
                metadata: {
                    totalFetched: items.length,
                    skipped,
                    errors,
                },
            };
        } catch (error) {
            logger.error('Failed to fetch Telegram channel', error, {
                sourceId: configInput.id,
                channelUsername: settings.channelUsername,
            });
            throw error;
        } finally {
            await client.disconnect();
        }
    },
};

function parseTelegramSettings(configInput: TelegramSourceConfig): ParsedTelegramSettings {
    const raw = (configInput.settings || {}) as TelegramSettingsInput;

    const channelUsername = normalizeTelegramChannel(
        getString(raw, ['channelUsername', 'channel_username']) || configInput.url
    );
    if (!channelUsername) {
        throw new Error('Telegram source requires channelUsername or a valid t.me URL');
    }

    const minDurationCandidate = getNumber(raw, ['minDurationSec', 'min_duration_sec']);
    const minDurationSec = typeof minDurationCandidate === 'number' && minDurationCandidate > 0
        ? Math.floor(minDurationCandidate)
        : DEFAULT_MIN_DURATION_SEC;

    const rawMediaTypes = getArray(raw, ['mediaTypes', 'media_types']);
    const requestedMediaTypes = Array.isArray(rawMediaTypes)
        ? rawMediaTypes.filter(
            (value): value is TelegramMediaType =>
                value === 'audio' || value === 'voice' || value === 'video' || value === 'photo'
        )
        : [];
    const mediaTypes: TelegramMediaType[] = requestedMediaTypes.length > 0
        ? requestedMediaTypes
        : ['audio', 'voice'];

    const maxResultsCandidate = getNumber(raw, ['maxResults', 'max_results']);
    const maxResults = typeof maxResultsCandidate === 'number' && maxResultsCandidate > 0
        ? Math.min(100, Math.floor(maxResultsCandidate))
        : DEFAULT_MAX_RESULTS;
    const maxDurationCandidate = getNumber(raw, ['maxDurationSec', 'max_duration_sec']);
    const maxDurationSec = typeof maxDurationCandidate === 'number' && maxDurationCandidate > 0
        ? Math.floor(maxDurationCandidate)
        : undefined;

    return {
        channelUsername,
        minDurationSec,
        maxDurationSec,
        mediaTypes,
        maxResults,
    };
}

function normalizeTelegramChannel(channelInput?: string): string {
    if (!channelInput) {
        return '';
    }

    const trimmed = channelInput.trim();
    if (!trimmed) {
        return '';
    }

    if (trimmed.startsWith('@')) {
        return trimmed;
    }

    if (trimmed.startsWith('https://t.me/') || trimmed.startsWith('http://t.me/')) {
        const withoutPrefix = trimmed.replace(/^https?:\/\/t\.me\//, '');
        const cleaned = withoutPrefix.replace(/^s\//, '');
        const username = cleaned.split('/')[0];
        return username ? `@${username}` : '';
    }

    if (trimmed.startsWith('https://telegram.me/') || trimmed.startsWith('http://telegram.me/')) {
        const withoutPrefix = trimmed.replace(/^https?:\/\/telegram\.me\//, '');
        const username = withoutPrefix.split('/')[0];
        return username ? `@${username}` : '';
    }

    return `@${trimmed}`;
}

function getChannelTitle(entity: unknown): string {
    const entityRecord = entity as Record<string, unknown>;
    const title = entityRecord['title'];
    return typeof title === 'string' && title.trim() ? title : 'Telegram Channel';
}

function getEntityId(entity: unknown): string | undefined {
    const entityRecord = entity as Record<string, unknown>;
    const id = entityRecord['id'];
    if (typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint') {
        return String(id);
    }
    return undefined;
}

function isEntityVerified(entity: unknown): boolean {
    const entityRecord = entity as Record<string, unknown>;
    return entityRecord['verified'] === true;
}

function getString(raw: TelegramSettingsInput, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

function getNumber(raw: TelegramSettingsInput, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === 'number') {
            return value;
        }
    }
    return undefined;
}

function getArray(raw: TelegramSettingsInput, keys: string[]): unknown[] | undefined {
    for (const key of keys) {
        const value = raw[key];
        if (Array.isArray(value)) {
            return value;
        }
    }
    return undefined;
}

export const telegramFetcherTestUtils = {
    normalizeTelegramChannel,
    parseTelegramSettings,
};

function extractTelegramAudio(message: unknown): {
    mediaKind: TelegramMediaType;
    durationSec?: number;
    fileName?: string;
    mimeType?: string;
    title?: string;
    author?: string;
} | null {
    const messageData = message as Record<string, unknown>;
    const media = messageData['media'] as Record<string, unknown> | undefined;
    if (!media) {
        return null;
    }

    const mediaClassName = media.constructor?.name;
    if (mediaClassName === 'MessageMediaPhoto') {
        return {
            mediaKind: 'photo',
            fileName: undefined,
            mimeType: 'image/jpeg',
            title: undefined,
            author: undefined,
        };
    }

    const document = media['document'] as Record<string, unknown> | undefined;
    if (!document) {
        return null;
    }

    const attributes = (document['attributes'] as unknown[]) || [];
    const audioAttribute = attributes.find((attribute) =>
        attribute instanceof Api.DocumentAttributeAudio
    ) as Api.DocumentAttributeAudio | undefined;
    const fileNameAttribute = attributes.find((attribute) =>
        attribute instanceof Api.DocumentAttributeFilename
    ) as Api.DocumentAttributeFilename | undefined;
    const videoAttribute = attributes.find((attribute) =>
        attribute instanceof Api.DocumentAttributeVideo
    ) as Api.DocumentAttributeVideo | undefined;

    if (audioAttribute) {
        const mediaKind: TelegramMediaType = audioAttribute.voice ? 'voice' : 'audio';
        return {
            mediaKind,
            durationSec: audioAttribute.duration ? Number(audioAttribute.duration) : undefined,
            fileName: fileNameAttribute?.fileName,
            mimeType: typeof document['mimeType'] === 'string' ? document['mimeType'] : undefined,
            title: audioAttribute.title || undefined,
            author: audioAttribute.performer || undefined,
        };
    }

    if (videoAttribute) {
        return {
            mediaKind: 'video',
            durationSec: videoAttribute.duration ? Number(videoAttribute.duration) : undefined,
            fileName: fileNameAttribute?.fileName,
            mimeType: typeof document['mimeType'] === 'string' ? document['mimeType'] : 'video/mp4',
            title: undefined,
            author: undefined,
        };
    }

    return null;
}

const NEWS_KEYWORDS = [
    'breaking',
    'news',
    'urgent',
    'report',
    'update',
    'official',
    'statement',
    'announced',
    'minister',
    'government',
    'president',
    'parliament',
    'election',
    'economy',
    'conflict',
];

function inferNewsSignals(input: { title: string; text: string }): {
    likelyNews: boolean;
    score: number;
    matchedKeywords: string[];
} {
    const haystack = `${input.title} ${input.text}`.toLowerCase();
    const matchedKeywords = NEWS_KEYWORDS.filter((keyword) => haystack.includes(keyword));
    const score = matchedKeywords.length;

    return {
        likelyNews: score >= 2,
        score,
        matchedKeywords,
    };
}
