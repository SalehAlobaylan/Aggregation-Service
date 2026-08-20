/**
 * Telegram Fetcher
 * Fetches media and text messages from public Telegram channels.
 * Media types fetched are controlled by the source's media_types config:
 *   audio / voice / video / photo → Pods feed (PODCAST / VIDEO / ARTICLE)
 *   text                          → News feed (ARTICLE)
 */
import { Api } from 'telegram';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { rateLimiter } from '../services/rate-limiter.js';
import {
    classifyTelegramError,
    createTelegramClient,
    disconnectTelegramClient,
} from '../services/telegram-client.js';
import type {
    Fetcher,
    FetchResult,
    RawFetchedItem,
    SourceConfig,
    TelegramMediaType,
    TelegramSourceConfig,
} from './types.js';
import { configuredMaximumDurationSec, configuredMinimumDurationSec, configuredResultLimit } from '../services/pods-admission.js';

const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_MIN_TEXT_LENGTH = 20;
const MAX_RESULTS_CAP = 200;

export function telegramCandidateLimit(maxResults: number): number {
    return Math.min(MAX_RESULTS_CAP, maxResults * 4);
}

interface ParsedTelegramSettings {
    channelUsername: string;
    minDurationSec: number;
    maxDurationSec?: number;
    mediaTypes: TelegramMediaType[];
    maxResults: number;
    /** Skip text/photo messages older than this many hours. Undefined = no age limit. */
    maxAgeHours?: number;
    /** Minimum character length for text posts to be ingested. */
    minTextLength: number;
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
            throw new Error('Telegram source rate limit exceeded');
        }

        const client = createTelegramClient();

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

            const candidateLimit = telegramCandidateLimit(settings.maxResults);
            for await (const message of client.iterMessages(entity, {
                limit: candidateLimit,
                offsetId,
            }) as AsyncIterable<Api.Message>) {
                try {
                    if (!message?.id) {
                        skipped++;
                        continue;
                    }
                    scannedMessages++;
                    // Cursor progress follows provider observations, not accepted
                    // items. Otherwise an all-short window repeats forever.
                    lastMessageId = message.id;

                    const extracted = extractTelegramContent(message);
                    if (!extracted) {
                        skipped++;
                        continue;
                    }

                    if (!settings.mediaTypes.includes(extracted.mediaKind)) {
                        skipped++;
                        continue;
                    }

                    // Age filter: Telegram iterates newest-first, so once we hit an old message
                    // everything that follows is even older — break out early.
                    if (settings.maxAgeHours !== undefined) {
                        const rawDate = message.date as unknown;
                        const messageDate = rawDate instanceof Date ? rawDate : null;
                        if (messageDate) {
                            const ageHours = (Date.now() - messageDate.getTime()) / (1000 * 60 * 60);
                            if (ageHours > settings.maxAgeHours) {
                                logger.debug('Telegram: stopping iteration — message exceeds max age', {
                                    messageId: message.id,
                                    ageHours: Math.round(ageHours),
                                    maxAgeHours: settings.maxAgeHours,
                                });
                                break;
                            }
                        }
                    }

                    // Minimum text length filter (only for text-only posts)
                    if (extracted.mediaKind === 'text') {
                        const rawMessageText = (message.message as string | undefined) || '';
                        if (rawMessageText.trim().length < settings.minTextLength) {
                            skipped++;
                            continue;
                        }
                    }

                    // Duration filter only applies to timed media (audio, voice, video)
                    const hasDurationFilter = extracted.mediaKind !== 'photo' && extracted.mediaKind !== 'text';
                    if (hasDurationFilter) {
                        const durationSec = extracted.durationSec;
                        if (!durationSec || durationSec < settings.minDurationSec) {
                            skipped++;
                            continue;
                        }
                        if (
                            typeof settings.maxDurationSec === 'number' &&
                            durationSec > settings.maxDurationSec
                        ) {
                            skipped++;
                            continue;
                        }
                    }

                    const rawMessageText = (message.message as string | undefined) || '';
                    const rawDate = message.date as unknown;
                    const publishedAt = rawDate instanceof Date
                        ? rawDate.toISOString()
                        : undefined;
                    const originalUrl = `https://t.me/${publicChannel}/${message.id}`;

                    // For text posts, derive title from message structure; for media, use embedded title
                    const { title, body } = extracted.mediaKind === 'text'
                        ? extractTitleAndBody(rawMessageText)
                        : {
                            title: extracted.title || rawMessageText || `Telegram ${extracted.mediaKind} ${message.id}`,
                            body: rawMessageText,
                        };

                    // telegramDownloadRef only needed for media types (not text)
                    const downloadRef = extracted.mediaKind !== 'text' ? {
                        channelUsername: settings.channelUsername,
                        channelId: getEntityId(entity),
                        messageId: message.id,
                        mediaKind: extracted.mediaKind,
                        fileName: extracted.fileName,
                        mimeType: extracted.mimeType,
                    } : undefined;

                    const item: RawFetchedItem = {
                        externalId: `${publicChannel}:${message.id}`,
                        sourceType: 'TELEGRAM',
                        url: originalUrl,
                        title,
                        content: body,
                        excerpt: body.substring(0, 300),
                        author: extracted.author || channelTitle,
                        publishedAt,
                        duration: extracted.durationSec,
                        metadata: {
                            channelUsername: settings.channelUsername,
                            channelTitle,
                            sourceVerified,
                            messageId: message.id,
                            mediaKind: extracted.mediaKind,
                            mimeType: extracted.mimeType,
                            fileName: extracted.fileName,
                            newsSignals: inferNewsSignals({ title, text: body }),
                            ...(downloadRef ? { telegramDownloadRef: downloadRef } : {}),
                        },
                        fetchedAt: new Date().toISOString(),
                    };

                    items.push(item);
                    if (items.length >= settings.maxResults) break;
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
                hasMore: scannedMessages >= candidateLimit && !!lastMessageId,
                metadata: {
                    totalFetched: items.length,
                    skipped,
                    errors,
                },
            };
        } catch (error) {
            const details = classifyTelegramError(error);
            if (details.transient) {
                logger.warn('Telegram fetch failed transiently and will be retried', {
                    sourceId: configInput.id,
                    channelUsername: settings.channelUsername,
                    code: details.code,
                    error: details.message,
                });
                throw new Error(`${details.code}: ${details.message}`, { cause: error });
            }
            logger.error('Failed to fetch Telegram channel', error, {
                sourceId: configInput.id,
                channelUsername: settings.channelUsername,
            });
            throw error;
        } finally {
            await disconnectTelegramClient(client, {
                sourceId: configInput.id,
                channelUsername: settings.channelUsername,
            });
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

    const minDurationSec = configuredMinimumDurationSec(raw);

    const rawMediaTypes = getArray(raw, ['mediaTypes', 'media_types']);
    const requestedMediaTypes = Array.isArray(rawMediaTypes)
        ? rawMediaTypes.filter(
            (value): value is TelegramMediaType =>
                value === 'audio' || value === 'voice' || value === 'video' || value === 'photo' || value === 'text'
        )
        : [];
    // Default to audio+voice for backwards compatibility.
    // Admins must explicitly add 'text' to fetch news text posts.
    const mediaTypes: TelegramMediaType[] = requestedMediaTypes.length > 0
        ? requestedMediaTypes
        : ['audio', 'voice'];

    const maxResults = configuredResultLimit(raw, DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);

    const maxDurationSec = configuredMaximumDurationSec(raw);
    if (maxDurationSec !== undefined && maxDurationSec < minDurationSec) {
        throw new Error('Telegram duration settings are contradictory: maximum is below minimum');
    }

    const maxAgeHoursCandidate = getNumber(raw, ['maxAgeHours', 'max_age_hours']);
    const maxAgeHours = typeof maxAgeHoursCandidate === 'number' && maxAgeHoursCandidate > 0
        ? Math.floor(maxAgeHoursCandidate)
        : undefined;

    const minTextLengthCandidate = getNumber(raw, ['minTextLength', 'min_text_length']);
    const minTextLength = typeof minTextLengthCandidate === 'number' && minTextLengthCandidate > 0
        ? Math.floor(minTextLengthCandidate)
        : DEFAULT_MIN_TEXT_LENGTH;

    return {
        channelUsername,
        minDurationSec,
        maxDurationSec,
        mediaTypes,
        maxResults,
        maxAgeHours,
        minTextLength,
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
    extractTelegramContent,
    extractTitleAndBody,
    classifyTelegramError,
    telegramCandidateLimit,
};

/**
 * Extracts content kind and metadata from a Telegram message.
 * Returns null if the message cannot be mapped to any supported media type.
 *
 * Text-only messages (no media attachment) are returned as mediaKind='text'.
 * Media messages (photo / audio / voice / video) return their respective kind.
 */
function extractTelegramContent(message: unknown): {
    mediaKind: TelegramMediaType;
    durationSec?: number;
    fileName?: string;
    mimeType?: string;
    title?: string;
    author?: string;
} | null {
    const messageData = message as Record<string, unknown>;
    const rawText = typeof messageData['message'] === 'string' ? messageData['message'].trim() : '';
    const media = messageData['media'] as Record<string, unknown> | undefined;

    // Text-only message — no media attachment at all
    // Length check is applied by the caller using settings.minTextLength
    if (!media) {
        if (rawText.length > 0) {
            return { mediaKind: 'text' };
        }
        return null;
    }

    // Photo message (may also have a text caption)
    const mediaClassName = (media.constructor as { name?: string } | undefined)?.name;
    if (mediaClassName === 'MessageMediaPhoto') {
        return {
            mediaKind: 'photo',
            mimeType: 'image/jpeg',
        };
    }

    // Document-based media (audio / voice / video)
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
        };
    }

    return null;
}

/**
 * Splits a raw text-post message into a title and body.
 * Many channels use a short first line as the headline.
 *
 * Rules (language-agnostic, works for Arabic and English):
 *   1. If the first line is ≤150 chars AND there is more content → first line = title, rest = body
 *   2. Otherwise → first 100 chars + "…" = title, full text = body
 */
function extractTitleAndBody(text: string): { title: string; body: string } {
    const trimmed = text.trim();
    const newlineIdx = trimmed.search(/\n+/);

    if (newlineIdx > 0 && newlineIdx <= 150) {
        const firstLine = trimmed.slice(0, newlineIdx).trim();
        const rest = trimmed.slice(newlineIdx).trim();
        if (firstLine.length > 0 && rest.length > 0) {
            return { title: firstLine, body: trimmed };
        }
    }

    const title = trimmed.length > 100 ? `${trimmed.slice(0, 100)}…` : trimmed;
    return { title, body: trimmed };
}

const NEWS_KEYWORDS = [
    // English
    'breaking', 'news', 'urgent', 'report', 'update', 'official',
    'statement', 'announced', 'minister', 'government', 'president',
    'parliament', 'election', 'economy', 'conflict',
    // Arabic
    'عاجل', 'أخبار', 'بيان', 'تقرير', 'رسمي', 'وزير',
    'حكومة', 'رئيس', 'انتخابات', 'اقتصاد', 'هجوم', 'زلزال',
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
