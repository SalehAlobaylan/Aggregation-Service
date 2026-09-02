/**
 * Media-Service HTTP client.
 *
 * Owns audio + image processing calls (transcribe, image embed). Text embedding
 * stays on enrichment-client.ts. Aggregation passes content_id to every call;
 * Media-Service writes back transcripts + image embeddings to CMS via its
 * /internal/* API, so callers don't need to do their own CMS writes.
 *
 * History: these functions used to live in enrichment-client.ts when there
 * was a single AI service. They moved here as part of the Media-Service split.
 */
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';

export interface TranscriptSegment {
    start: number;
    end: number;
    text: string;
}

export interface TranscriptResult {
    text: string;
    language?: string;
    segments?: TranscriptSegment[];
    /** Media's CMS write-back result: 'ok' | 'failed' | undefined (no content_id). */
    writeBackStatus?: string;
    writeBackError?: string | null;
}

export interface YouTubeCaptionImport {
    contentItemId: string;
    fullText: string;
    language: string;
    segments: TranscriptSegment[];
    chapters?: Array<{ start: number; end: number; title: string; source: 'youtube' | 'derived' }>;
    source: 'youtube_human' | 'youtube_auto';
}

const TRANSCRIBE_TIMEOUT_MS = 600_000; // 10 min — long-form podcasts
const EMBED_TIMEOUT_MS = 30_000;

/** Strip any trailing slash so we never produce `//v1/...` URLs. */
function baseUrl(): string {
    return config.mediaBaseUrl.replace(/\/+$/, '');
}

function requestSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
}

function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (config.mediaServiceToken) {
        headers.Authorization = `Bearer ${config.mediaServiceToken}`;
    }
    return headers;
}

function tracingHeaders(requestId?: string): Record<string, string> {
    return requestId ? { 'X-Request-ID': requestId } : {};
}

/** Transcribe a durable URL synchronously. Kept for short work only. */
export async function transcribeUrlViaMedia(
    url: string,
    contentItemId?: string,
    opts: { language?: string; wordTimestamps?: boolean; requestId?: string; transcriptionJobId?: string; signal?: AbortSignal } = {},
): Promise<TranscriptResult> {
    const { language, wordTimestamps = true, requestId, transcriptionJobId } = opts;
    const form = new FormData();
    form.append('url', url);
    if (contentItemId) form.append('content_id', contentItemId);
    if (transcriptionJobId) form.append('transcription_job_id', transcriptionJobId);
    if (language) form.append('language', language);
    form.append('word_timestamps', wordTimestamps ? 'true' : 'false');

    const response = await fetch(`${baseUrl()}/v1/transcribe`, {
        method: 'POST',
        body: form,
        headers: { ...authHeaders(), ...tracingHeaders(requestId) },
        signal: requestSignal(opts.signal, TRANSCRIBE_TIMEOUT_MS),
    });
    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Media /v1/transcribe failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    const result = (await response.json()) as {
        text?: string;
        language?: string;
        segments?: TranscriptSegment[];
        write_back_status?: string;
        write_back_error?: string | null;
    };
    return {
        text: result.text || '',
        language: result.language,
        segments: result.segments,
        writeBackStatus: result.write_back_status,
        writeBackError: result.write_back_error ?? null,
    };
}

export async function importYouTubeCaptionViaMedia(
    caption: YouTubeCaptionImport,
    opts: { requestId?: string; signal?: AbortSignal } = {},
): Promise<{ transcriptId?: string }> {
    const response = await fetch(`${baseUrl()}/v1/captions/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(), ...tracingHeaders(opts.requestId) },
        body: JSON.stringify({
            content_item_id: caption.contentItemId,
            full_text: caption.fullText,
            language: caption.language,
            segments: caption.segments,
            chapters: caption.chapters ?? [],
            source: caption.source,
            provider: 'youtube',
        }),
        signal: requestSignal(opts.signal, 30_000),
    });
    if (!response.ok) throw new Error(`Media /v1/captions/import failed: ${response.status}`);
    const result = (await response.json()) as { status?: string; transcript_id?: string; error?: string };
    if (result.status !== 'ok') throw new Error(result.error || 'Media rejected caption import');
    return { transcriptId: result.transcript_id };
}

/**
 * Submit an async transcription job. Returns the job ID for polling.
 *
 * Use this for long-form audio (>2 min) where the synchronous endpoint risks
 * gateway timeouts. Media-Service runs the actual transcription in a separate
 * arq worker process and writes the transcript back to CMS via content_id.
 */
export async function submitTranscribeJobViaMedia(
    url: string,
    contentItemId?: string,
    opts: { language?: string; wordTimestamps?: boolean; requestId?: string; transcriptionJobId?: string; signal?: AbortSignal } = {},
): Promise<string> {
    const { language, wordTimestamps = true, requestId, transcriptionJobId } = opts;

    const form = new FormData();
    form.append('url', url);
    if (contentItemId) form.append('content_id', contentItemId);
    if (transcriptionJobId) form.append('transcription_job_id', transcriptionJobId);
    if (language) form.append('language', language);
    form.append('word_timestamps', wordTimestamps ? 'true' : 'false');

    const response = await fetch(`${baseUrl()}/v1/transcribe/jobs`, {
        method: 'POST',
        body: form,
        headers: {
            ...authHeaders(),
            ...tracingHeaders(requestId),
        },
        signal: requestSignal(opts.signal, 60_000), // upload only — should be fast
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Media /v1/transcribe/jobs failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }

    const result = (await response.json()) as { job_id: string; status: string };
    if (!result.job_id) {
        throw new Error('Media /v1/transcribe/jobs returned no job_id');
    }
    return result.job_id;
}

export interface TranscribeJobStatus {
    jobId: string;
    status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'not_found';
    result?: TranscriptResult;
    error?: string;
}

/**
 * Poll the status of an async transcription job. One HTTP call; caller is
 * responsible for the polling loop. Use `transcribeAsyncViaMedia` for a
 * built-in wait-until-done.
 */
export async function getTranscribeJobStatusViaMedia(
    jobId: string,
    opts: { requestId?: string; signal?: AbortSignal } = {},
): Promise<TranscribeJobStatus> {
    const response = await fetch(`${baseUrl()}/v1/transcribe/jobs/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers: {
            ...authHeaders(),
            ...tracingHeaders(opts.requestId),
        },
        signal: requestSignal(opts.signal, 10_000),
    });

    if (response.status === 404) {
        return { jobId, status: 'not_found' };
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Media GET /v1/transcribe/jobs/${jobId} failed: ${response.status} - ${errorText}`,
        );
    }

    const body = (await response.json()) as {
        job_id: string;
        status: TranscribeJobStatus['status'];
        result?: {
            text?: string;
            language?: string;
            segments?: TranscriptSegment[];
            write_back_status?: string;
            write_back_error?: string | null;
        };
        error?: string | null;
    };

    let result: TranscriptResult | undefined;
    if (body.result) {
        result = {
            text: body.result.text || '',
            language: body.result.language,
            segments: body.result.segments,
            writeBackStatus: body.result.write_back_status,
            writeBackError: body.result.write_back_error ?? null,
        };
    }

    return {
        jobId: body.job_id,
        status: body.status,
        result,
        error: body.error ?? undefined,
    };
}

/**
 * Submit + poll until terminal. Polls every `pollIntervalMs` (default 5s),
 * gives up after `maxWaitMs` (default 30 min).
 */
export async function transcribeAsyncViaMedia(
    url: string,
    contentItemId?: string,
    opts: {
        language?: string;
        wordTimestamps?: boolean;
        requestId?: string;
        transcriptionJobId?: string;
        pollIntervalMs?: number;
        maxWaitMs?: number;
        signal?: AbortSignal;
    } = {},
): Promise<TranscriptResult> {
    const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    const maxWaitMs = opts.maxWaitMs ?? 30 * 60_000;

    const jobId = await submitTranscribeJobViaMedia(url, contentItemId, opts);
    logger.info('Media async transcribe job submitted', { jobId, contentItemId });

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, pollIntervalMs);
            opts.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(opts.signal?.reason);
            }, { once: true });
        });
        const status = await getTranscribeJobStatusViaMedia(jobId, {
            requestId: opts.requestId,
            signal: opts.signal,
        });
        if (status.status === 'completed' && status.result) {
            return status.result;
        }
        if (status.status === 'failed') {
            throw new Error(`Media transcribe job ${jobId} failed: ${status.error}`);
        }
        if (status.status === 'not_found') {
            throw new Error(`Media transcribe job ${jobId} not found`);
        }
    }
    throw new Error(
        `Media transcribe job ${jobId} did not complete within ${maxWaitMs}ms`,
    );
}

export interface ImageEmbedResult {
    /** Single 512-dim CLIP-ViT-B-32 embedding vector. */
    embedding: number[];
    writeBackStatus?: string;
    writeBackError?: string | null;
}

/**
 * Embed an image (by URL) via Media-Service /v1/embed/image.
 *
 * When `contentItemId` is supplied, Media writes the 512-dim vector to the
 * content_items.image_embedding column. Independent from the text embedding
 * (which Enrichment-Service writes to content_items.embedding) — both can
 * coexist on the same row.
 *
 * Image embedding is secondary content enrichment — callers should treat
 * failures as non-blocking (don't fail the AI job because a thumbnail
 * couldn't be embedded).
 */
export async function embedImageViaMedia(
    imageUrl: string,
    contentItemId?: string,
    opts: { requestId?: string; signal?: AbortSignal } = {},
): Promise<ImageEmbedResult> {
    const form = new FormData();
    form.append('url', imageUrl);
    if (contentItemId) form.append('content_id', contentItemId);

    const response = await fetch(`${baseUrl()}/v1/embed/image`, {
        method: 'POST',
        body: form,
        headers: {
            ...authHeaders(),
            ...tracingHeaders(opts.requestId),
        },
        signal: requestSignal(opts.signal, EMBED_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Media /v1/embed/image failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }

    const result = (await response.json()) as {
        embedding: number[];
        write_back_status?: string;
        write_back_error?: string | null;
    };

    if (!result.embedding || result.embedding.length === 0) {
        throw new Error('Media /v1/embed/image returned empty vector');
    }

    if (contentItemId && result.write_back_status === 'failed') {
        logger.warn('Media image embedding write-back did not complete', {
            contentItemId,
            writeBackError: result.write_back_error,
        });
    }

    return {
        embedding: result.embedding,
        writeBackStatus: result.write_back_status,
        writeBackError: result.write_back_error ?? null,
    };
}
