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

/**
 * Generate a 384-dim embedding via Enrichment-Service.
 *
 * If `contentItemId` is supplied, Enrichment writes the vector to CMS itself
 * via PATCH /internal/content-items/{id}/embedding. Returns the vector to
 * callers regardless (useful for nearest-neighbor lookups before persistence).
 */
export async function generateEmbeddingViaEnrichment(
    text: string,
    contentItemId?: string,
    opts: { requestId?: string } = {},
): Promise<number[]> {
    const body: { texts: string[]; content_ids?: string[] } = { texts: [text] };
    if (contentItemId) body.content_ids = [contentItemId];

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

    return result.embeddings[0];
}
