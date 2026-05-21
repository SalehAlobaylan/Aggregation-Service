/**
 * Enrichment-Service HTTP client.
 *
 * Replaces the legacy onerahmet/whisper sidecar (transcription) and the local
 * @xenova/transformers embedder. Aggregation passes content_id to every call;
 * Enrichment writes back transcripts + embeddings to CMS via its /internal/*
 * API, so callers don't need to do their own CMS writes.
 */
import FormData from 'form-data';
import { createReadStream } from 'fs';
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
    /** Enrichment's CMS write-back result: 'ok' | 'failed' | undefined (no content_id). */
    writeBackStatus?: string;
    writeBackError?: string | null;
}

const TRANSCRIBE_TIMEOUT_MS = 600_000; // 10 min — long-form podcasts
const EMBED_TIMEOUT_MS = 30_000;

/** Strip any trailing slash so we never produce `//v1/...` URLs. */
function baseUrl(): string {
    return config.enrichmentBaseUrl.replace(/\/+$/, '');
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

/**
 * Transcribe an audio file via Enrichment-Service.
 *
 * If `contentItemId` is supplied, Enrichment writes the transcript to CMS
 * itself (and links it to the content item). The response surfaces the
 * write-back outcome via writeBackStatus.
 */
export async function transcribeViaEnrichment(
    audioPath: string,
    contentItemId?: string,
    opts: { language?: string; wordTimestamps?: boolean; requestId?: string } = {},
): Promise<TranscriptResult> {
    const { language, wordTimestamps = true, requestId } = opts;

    logger.info('Calling Enrichment /v1/transcribe', {
        audioPath,
        contentItemId,
        wordTimestamps,
    });

    const form = new FormData();
    form.append('audio_file', createReadStream(audioPath));
    if (contentItemId) form.append('content_id', contentItemId);
    if (language) form.append('language', language);
    form.append('word_timestamps', wordTimestamps ? 'true' : 'false');

    const response = await fetch(`${baseUrl()}/v1/transcribe`, {
        method: 'POST',
        body: form as unknown as BodyInit,
        headers: {
            ...form.getHeaders(),
            ...authHeaders(),
            ...tracingHeaders(requestId),
        },
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/transcribe failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
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

export interface EmbedResult {
    /** Single 384-dim embedding vector. */
    embedding: number[];
    /** When extractTags was requested and the LLM succeeded. */
    tags?: string[];
    entities?: {
        people?: string[];
        organizations?: string[];
        locations?: string[];
    };
}

/**
 * Submit an async transcription job. Returns the job ID for polling.
 *
 * Use this for long-form audio (>2 min) where the synchronous endpoint risks
 * gateway timeouts. Enrichment runs the actual transcription in a separate
 * worker process and writes the transcript back to CMS via content_id.
 */
export async function submitTranscribeJobViaEnrichment(
    audioPath: string,
    contentItemId?: string,
    opts: { language?: string; wordTimestamps?: boolean; requestId?: string } = {},
): Promise<string> {
    const { language, wordTimestamps = true, requestId } = opts;

    const form = new FormData();
    form.append('audio_file', createReadStream(audioPath));
    if (contentItemId) form.append('content_id', contentItemId);
    if (language) form.append('language', language);
    form.append('word_timestamps', wordTimestamps ? 'true' : 'false');

    const response = await fetch(`${baseUrl()}/v1/transcribe/jobs`, {
        method: 'POST',
        body: form as unknown as BodyInit,
        headers: {
            ...form.getHeaders(),
            ...authHeaders(),
            ...tracingHeaders(requestId),
        },
        signal: AbortSignal.timeout(60_000), // upload only — should be fast
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/transcribe/jobs failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }

    const result = (await response.json()) as { job_id: string; status: string };
    if (!result.job_id) {
        throw new Error('Enrichment /v1/transcribe/jobs returned no job_id');
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
 * responsible for the polling loop. Use `pollTranscribeJobViaEnrichment` for
 * a built-in wait-until-done.
 */
export async function getTranscribeJobStatusViaEnrichment(
    jobId: string,
    opts: { requestId?: string } = {},
): Promise<TranscribeJobStatus> {
    const response = await fetch(`${baseUrl()}/v1/transcribe/jobs/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers: {
            ...authHeaders(),
            ...tracingHeaders(opts.requestId),
        },
        signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 404) {
        return { jobId, status: 'not_found' };
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment GET /v1/transcribe/jobs/${jobId} failed: ${response.status} - ${errorText}`,
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
export async function transcribeAsyncViaEnrichment(
    audioPath: string,
    contentItemId?: string,
    opts: {
        language?: string;
        wordTimestamps?: boolean;
        requestId?: string;
        pollIntervalMs?: number;
        maxWaitMs?: number;
    } = {},
): Promise<TranscriptResult> {
    const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    const maxWaitMs = opts.maxWaitMs ?? 30 * 60_000;

    const jobId = await submitTranscribeJobViaEnrichment(audioPath, contentItemId, opts);
    logger.info('Enrichment async transcribe job submitted', { jobId, contentItemId });

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        const status = await getTranscribeJobStatusViaEnrichment(jobId, {
            requestId: opts.requestId,
        });
        if (status.status === 'completed' && status.result) {
            return status.result;
        }
        if (status.status === 'failed') {
            throw new Error(`Enrichment transcribe job ${jobId} failed: ${status.error}`);
        }
        if (status.status === 'not_found') {
            throw new Error(`Enrichment transcribe job ${jobId} not found`);
        }
    }
    throw new Error(
        `Enrichment transcribe job ${jobId} did not complete within ${maxWaitMs}ms`,
    );
}

/**
 * Generate a 384-dim embedding via Enrichment-Service.
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
    opts: { requestId?: string; extractTags?: boolean } = {},
): Promise<EmbedResult> {
    const body: {
        texts: string[];
        content_ids?: string[];
        extract_tags?: boolean;
    } = { texts: [text] };
    if (contentItemId) body.content_ids = [contentItemId];
    if (opts.extractTags) body.extract_tags = true;

    const response = await fetch(`${baseUrl()}/v1/embed`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...tracingHeaders(opts.requestId),
        },
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/embed failed: ${response.status} ${response.statusText} - ${errorText}`,
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
        tags: result.tags ?? undefined,
        entities: result.entities ?? undefined,
    };
}

export interface ImageEmbedResult {
    /** Single 512-dim CLIP-ViT-B-32 embedding vector. */
    embedding: number[];
    writeBackStatus?: string;
    writeBackError?: string | null;
}

/**
 * Embed an image (by URL) via Enrichment-Service /v1/embed/image.
 *
 * When `contentItemId` is supplied, Enrichment writes the 512-dim vector to
 * the content_items.image_embedding column. Independent from the text
 * embedding — both can coexist on the same row.
 *
 * Image embedding is secondary content enrichment — callers should treat
 * failures as non-blocking (don't fail the AI job because a thumbnail
 * couldn't be embedded).
 */
export async function embedImageViaEnrichment(
    imageUrl: string,
    contentItemId?: string,
    opts: { requestId?: string } = {},
): Promise<ImageEmbedResult> {
    const form = new FormData();
    form.append('url', imageUrl);
    if (contentItemId) form.append('content_id', contentItemId);

    const response = await fetch(`${baseUrl()}/v1/embed/image`, {
        method: 'POST',
        body: form as unknown as BodyInit,
        headers: {
            ...form.getHeaders(),
            ...authHeaders(),
            ...tracingHeaders(opts.requestId),
        },
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
            `Enrichment /v1/embed/image failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
    }

    const result = (await response.json()) as {
        embedding: number[];
        write_back_status?: string;
        write_back_error?: string | null;
    };

    if (!result.embedding || result.embedding.length === 0) {
        throw new Error('Enrichment /v1/embed/image returned empty vector');
    }

    if (contentItemId && result.write_back_status === 'failed') {
        logger.warn('Enrichment image embedding write-back did not complete', {
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
