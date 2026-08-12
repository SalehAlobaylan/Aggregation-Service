/**
 * Enrichment-Service HTTP client.
 *
 * Owns text-intelligence calls (embedding, future: translate/summarize/related
 * if Aggregation ever needs them — today it doesn't). Audio + image processing
 * calls (transcribe, image embed) live in media-client.ts after the
 * Media-Service split.
 *
 * Aggregation passes content_id to every call; Enrichment writes back
 * embeddings + topic_tags to CMS via its /internal/* API.
 */
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';

const EMBED_TIMEOUT_MS = 30_000;
const CHAPTERS_TIMEOUT_MS = 90_000;

/** Strip any trailing slash so we never produce `//v1/...` URLs. */
function baseUrl(): string {
    return config.enrichmentBaseUrl.replace(/\/+$/, '');
}

function requestSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
}

function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (config.enrichmentServiceToken) {
        headers.Authorization = `Bearer ${config.enrichmentServiceToken}`;
    }
    return headers;
}

function tracingHeaders(requestId?: string): Record<string, string> {
    return requestId ? { 'X-Request-ID': requestId } : {};
}

export interface EmbedResult {
    /** Qwen3 dense text embedding vector (1024 dimensions in the current Wahb stack). */
    embedding: number[];
    /**
     * Whether Enrichment persisted the vector to CMS. `not_attempted` when no
     * content_id was supplied (stateless mode). The AI worker gates READY on
     * this so content is never published without its embedding.
     */
    writeBackStatus: 'not_attempted' | 'ok' | 'failed';
    writeBackError?: string;
    /** When extractTags was requested and the LLM succeeded. */
    tags?: string[];
    entities?: {
        people?: string[];
        organizations?: string[];
        locations?: string[];
    };
}

interface EnrichmentErrorPayload {
    error?: string;
    error_code?: string;
    retryable?: boolean;
    retry_after_seconds?: number;
}

export class EnrichmentRequestError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly retryable: boolean,
        readonly retryAfterSeconds?: number,
        readonly errorCode?: string,
    ) {
        super(message);
        this.name = 'EnrichmentRequestError';
    }
}

export function isRetryableEnrichmentError(error: unknown): boolean {
    return error instanceof EnrichmentRequestError && error.retryable;
}

export interface ChapterWindowPayload {
    index: number;
    start_sec: number;
    text: string;
}

export interface GeneratedChapterPlan {
    start_index: number;
    end_index?: number | null;
    title: string;
    summary?: string | null;
    context_label?: string | null;
    confidence?: number;
    boundary_reason?: string | null;
    standalone_score?: number;
    contains_sponsor_or_intro?: boolean;
    needs_review_reason?: string | null;
}

export async function generateChaptersViaEnrichment(
    windows: ChapterWindowPayload[],
    opts: {
        requestId?: string;
        language?: string | null;
        maxChapters?: number;
        minSec?: number;
        maxSec?: number;
        signal?: AbortSignal;
    } = {},
): Promise<GeneratedChapterPlan[]> {
    const response = await fetch(`${baseUrl()}/v1/chapters/generate`, {
        method: 'POST',
        body: JSON.stringify({
            windows,
            mode: opts.maxChapters ? 'count' : 'auto',
            target_count: opts.maxChapters,
            min_sec: opts.minSec,
            max_sec: opts.maxSec,
            with_summary: true,
            language: opts.language,
        }),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(opts.requestId),
        },
        signal: requestSignal(opts.signal, CHAPTERS_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/chapters/generate failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }

    const result = (await response.json()) as { chapters?: GeneratedChapterPlan[] };
    return result.chapters ?? [];
}

/**
 * Generate a text embedding via Enrichment-Service.
 *
 * If `contentItemId` is supplied, Enrichment writes the vector (and tags, if
 * requested) to CMS itself. Returns the vector to callers regardless — useful
 * for nearest-neighbor lookups before persistence completes.
 *
 * Set `extractTags: true` to also pull topic tags + named entities via LLM.
 * Costs an additional LLM call; enable only for long-form content types
 * (ARTICLE/VIDEO/PODCAST) where the tags are worth the cost.
 */
export async function generateEmbeddingViaEnrichment(
    text: string,
    contentItemId?: string,
    opts: {
        requestId?: string;
        extractTags?: boolean;
        signal?: AbortSignal;
        pipelineRepair?: {
            repair_id: string;
            attempt_id: string;
            claim_token: string;
            fence_token: string;
            expected_item_version: string;
            input_digest: string;
        };
    } = {},
): Promise<EmbedResult> {
    const body: {
        texts: string[];
        content_ids?: string[];
        extract_tags?: boolean;
        pipeline_repair?: NonNullable<typeof opts.pipelineRepair>;
    } = { texts: [text] };
    if (contentItemId) body.content_ids = [contentItemId];
    if (opts.extractTags) body.extract_tags = true;
    if (opts.pipelineRepair) body.pipeline_repair = opts.pipelineRepair;

    const response = await fetch(`${baseUrl()}/v1/embed`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(opts.requestId),
        },
        signal: requestSignal(opts.signal, EMBED_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        let payload: EnrichmentErrorPayload = {};
        try {
            payload = JSON.parse(errorText) as EnrichmentErrorPayload;
        } catch {
            // Preserve the raw response below when upstream did not return JSON.
        }
        const retryable = payload.retryable === true || response.status === 429 || response.status >= 500;
        const retryAfterHeader = Number(response.headers?.get?.('retry-after'));
        const retryAfterSeconds = payload.retry_after_seconds
            ?? (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : undefined);
        throw new EnrichmentRequestError(
            `Enrichment /v1/embed failed: ${response.status} ${response.statusText} - ${payload.error ?? errorText}`,
            response.status,
            retryable,
            retryAfterSeconds,
            payload.error_code,
        );
    }

    const result = (await response.json()) as {
        embeddings: number[][];
        dimensions?: number;
        write_back_status?: 'not_attempted' | 'ok' | 'failed';
        write_back_error?: string | null;
        tags?: string[] | null;
        entities?: EmbedResult['entities'] | null;
    };

    if (!result.embeddings || result.embeddings.length === 0) {
        throw new Error('Enrichment /v1/embed returned no embeddings');
    }

    // Surface silent CMS write-back failures. We still return the vector
    // (it's valid) — caller decides whether to fail the job, retry, etc.
    if (contentItemId && result.write_back_status === 'failed') {
        logger.warn('Enrichment embedding write-back did not complete', {
            contentItemId,
            writeBackError: result.write_back_error,
        });
    }

    return {
        embedding: result.embeddings[0],
        writeBackStatus: result.write_back_status ?? 'not_attempted',
        writeBackError: result.write_back_error ?? undefined,
        tags: result.tags ?? undefined,
        entities: result.entities ?? undefined,
    };
}

export interface TelegramChannelInfo {
    username: string;
    exists: boolean;
    title: string | null;
    subscribers: number;
    posts: { text: string; datetime: string | null; views: string | null }[];
    forwarded: string[];
    mentioned: string[];
}

const TELEGRAM_TIMEOUT_MS = 40_000;

/**
 * Scrape a Telegram channel's public preview (t.me/s/<username>) via Enrichment.
 * Stealth web extraction is Enrichment's boundary; Aggregation only orchestrates
 * the forward-graph. Returns exists:false for private/missing channels.
 */
export async function fetchTelegramChannel(
    username: string,
    requestId?: string,
): Promise<TelegramChannelInfo> {
    const response = await fetch(`${baseUrl()}/v1/extract/telegram`, {
        method: 'POST',
        body: JSON.stringify({ username }),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(requestId),
        },
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/extract/telegram failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }

    return (await response.json()) as TelegramChannelInfo;
}

export interface TwitterPostInfo {
    id: string;
    text: string;
    created_at: string | null;
    url: string | null;
    likes: number;
    retweets: number;
    replies: number;
    is_retweet: boolean;
    is_reply: boolean;
}

export interface TwitterProfileInfo {
    username: string;
    exists: boolean;
    rate_limited?: boolean;
    name: string | null;
    followers: number;
    verified: boolean;
    image_url: string | null;
    description: string;
    posts: TwitterPostInfo[];
    retweeted: string[];
    quoted: string[];
    mentioned: string[];
}

/**
 * Scrape an X profile's public syndication timeline via Enrichment. Stealth
 * extraction is Enrichment's boundary; Aggregation orchestrates the
 * interaction-graph + ingestion. Returns exists:false on missing/throttled.
 */
export async function fetchTwitterProfile(
    username: string,
    requestId?: string,
): Promise<TwitterProfileInfo> {
    const response = await fetch(`${baseUrl()}/v1/extract/twitter`, {
        method: 'POST',
        body: JSON.stringify({ username }),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(requestId),
        },
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/extract/twitter failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }

    return (await response.json()) as TwitterProfileInfo;
}

export interface TwitterRecAccount {
    username: string;
    name: string | null;
    followers: number;
    friends: number;
    statuses: number;
    listed: number;
    verified: boolean;
    is_protected: boolean;
    description: string;
    url: string | null;
    image_url: string | null;
    created_at: string | null;
    user_id: string | null;
}

export interface TwitterRecommendationsResult {
    seed: string;
    exists: boolean;
    rate_limited?: boolean;
    recommendations: TwitterRecAccount[];
}

/**
 * Fetch X's "who to follow" / قد يعجبك recommendations for a seed account via
 * Enrichment (guest-accessible REST — no login, no account-ban risk). Seed-
 * relative: feeding a trusted source returns accounts X considers similar, the
 * Source Intelligence relatedness signal. Each recommendation carries inline
 * validation fields (followers/desc/statuses) — no profile re-fetch needed.
 */
export async function fetchTwitterRecommendations(
    seed: string,
    opts: { limit?: number; requestId?: string } = {},
): Promise<TwitterRecommendationsResult> {
    const response = await fetch(`${baseUrl()}/v1/extract/twitter/recommendations`, {
        method: 'POST',
        body: JSON.stringify({ seed, limit: opts.limit ?? 40 }),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(opts.requestId),
        },
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/extract/twitter/recommendations failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }

    return (await response.json()) as TwitterRecommendationsResult;
}

export interface YouTubeVideoInfo {
    video_id: string;
    title: string;
}

export interface YouTubeChannelInfo {
    channel: string;
    exists: boolean;
    channel_id: string | null;
    title: string | null;
    subscribers: number;
    description: string;
    image_url: string | null;
    videos: YouTubeVideoInfo[];
    category: string | null;
    audio_first: boolean;
    top_duration_sec: number;
}

export interface YouTubeRelatedChannel {
    channel_id: string;
    name: string | null;
    via: string;
}

export interface YouTubeRelatedResult {
    channel: string;
    exists: boolean;
    related: YouTubeRelatedChannel[];
}

/**
 * Read a YouTube channel via Enrichment's guest InnerTube reader (no API key, no
 * quota). Stealth/extraction is Enrichment's boundary; Aggregation orchestrates
 * the media graph. Returns exists:false on missing/throttled (graceful).
 */
export async function fetchYouTubeChannel(
    channel: string,
    requestId?: string,
): Promise<YouTubeChannelInfo> {
    const response = await fetch(`${baseUrl()}/v1/extract/youtube`, {
        method: 'POST',
        body: JSON.stringify({ channel }),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(requestId),
        },
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/extract/youtube failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }
    return (await response.json()) as YouTubeChannelInfo;
}

/**
 * Channels in a seed channel's watch-next graph (the YouTube relatedness signal).
 */
export async function fetchYouTubeRelated(
    channel: string,
    requestId?: string,
): Promise<YouTubeRelatedResult> {
    const response = await fetch(`${baseUrl()}/v1/extract/youtube/related`, {
        method: 'POST',
        body: JSON.stringify({ channel }),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(requestId),
        },
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/extract/youtube/related failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }
    return (await response.json()) as YouTubeRelatedResult;
}

export interface YouTubeSearchChannel {
    channel_id: string;
    title: string | null;
    subscribers: number;
}

/**
 * Topic/keyword YouTube channel search via Enrichment's guest InnerTube — the
 * YouTube analog of the iTunes podcast keyword net (no API key, no quota).
 */
export async function searchYouTubeChannels(
    query: string,
    opts: { limit?: number; requestId?: string } = {},
): Promise<YouTubeSearchChannel[]> {
    const response = await fetch(`${baseUrl()}/v1/extract/youtube/search`, {
        method: 'POST',
        body: JSON.stringify({ query, limit: opts.limit ?? 15 }),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(opts.requestId),
        },
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/extract/youtube/search failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }
    const data = (await response.json()) as { channels: YouTubeSearchChannel[] };
    return data.channels ?? [];
}

export interface ExtractedChannel {
    channel_id: string;
    title: string | null;
    handle: string | null;
    is_podcast: boolean;
    episode_count: number;
    subscribers: number;
    mention_count: number;
}

/**
 * Podcast-intent YouTube search via Enrichment's guest InnerTube. Unlike the
 * channels-only `searchYouTubeChannels`, this parses YouTube's podcast shelves +
 * video owners for a "بودكاست <topic>" query, so the famous podcast networks
 * (إذاعة ثمانية / Mics مايكس …) actually surface. No API key, no quota.
 */
export async function searchYouTubePodcasts(
    query: string,
    opts: { limit?: number; requestId?: string } = {},
): Promise<ExtractedChannel[]> {
    const response = await fetch(`${baseUrl()}/v1/extract/youtube/podcast-search`, {
        method: 'POST',
        body: JSON.stringify({ query, limit: opts.limit ?? 15 }),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(opts.requestId),
        },
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/extract/youtube/podcast-search failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }
    const data = (await response.json()) as { channels: ExtractedChannel[] };
    return data.channels ?? [];
}

/**
 * Parse a pasted youtubei/v1 response (e.g. an admin's personalized home feed)
 * into the distinct channels it references — the manual seed path. Stateless;
 * the admin stays the authenticated session, we store no credentials.
 */
export async function parseYouTubeFeed(
    raw: unknown,
    requestId?: string,
): Promise<ExtractedChannel[]> {
    const response = await fetch(`${baseUrl()}/v1/extract/youtube/parse-feed`, {
        method: 'POST',
        body: JSON.stringify({ raw }),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(requestId),
        },
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/extract/youtube/parse-feed failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }
    const data = (await response.json()) as { channels: ExtractedChannel[] };
    return data.channels ?? [];
}

/**
 * Resolve pasted YouTube references (a @handle, channel URL, /channel/UC… URL,
 * raw UC… id, or any video / share / shorts link) into the channels behind them
 * via guest InnerTube (no auth, no quota). The low-friction seed path — each line
 * is two taps off YouTube's Share button instead of a 1 MB DevTools JSON paste.
 */
export async function resolveYouTubeLinks(
    inputs: string[],
    requestId?: string,
): Promise<ExtractedChannel[]> {
    const response = await fetch(`${baseUrl()}/v1/extract/youtube/resolve-links`, {
        method: 'POST',
        body: JSON.stringify({ inputs }),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(requestId),
        },
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/extract/youtube/resolve-links failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }
    const data = (await response.json()) as { channels: ExtractedChannel[] };
    return data.channels ?? [];
}

export interface AppleRelatedShow {
    adam_id: string;
    title: string | null;
    genres: string[];
}

export interface ApplePodcastRelatedResult {
    collection_id: string;
    exists: boolean;
    related: AppleRelatedShow[];
}

/**
 * A podcast's Apple "Listeners Also Subscribed" / "You Might Also Like" shelf via
 * Enrichment (scraped from the public show page — no token). The co-listen
 * relation; each adam_id resolves to an RSS feed via the iTunes lookup API.
 */
export async function fetchApplePodcastRelated(
    collectionId: string,
    opts: { country?: string; requestId?: string } = {},
): Promise<ApplePodcastRelatedResult> {
    const response = await fetch(`${baseUrl()}/v1/extract/apple-podcast/related`, {
        method: 'POST',
        body: JSON.stringify({ collection_id: collectionId, country: opts.country ?? 'us' }),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(opts.requestId),
        },
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/extract/apple-podcast/related failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }
    return (await response.json()) as ApplePodcastRelatedResult;
}
