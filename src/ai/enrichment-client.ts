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

export interface EmbedResult {
    /** Single text embedding vector (384-dim today, 1024-dim after Slice 0 / BGE-M3). */
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
 *
 * Set `extractSparse: true` to populate BGE-M3's sparse (lexical-weights)
 * output alongside dense — required to participate in /v1/related hybrid
 * retrieval. Free in compute (same forward pass as dense); enable for the
 * same long-form cohort as tags.
 */
export async function generateEmbeddingViaEnrichment(
    text: string,
    contentItemId?: string,
    opts: { requestId?: string; extractTags?: boolean; extractSparse?: boolean } = {},
): Promise<EmbedResult> {
    const body: {
        texts: string[];
        content_ids?: string[];
        extract_tags?: boolean;
        extract_sparse?: boolean;
    } = { texts: [text] };
    if (contentItemId) body.content_ids = [contentItemId];
    if (opts.extractTags) body.extract_tags = true;
    if (opts.extractSparse) body.extract_sparse = true;

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
        writeBackStatus: result.write_back_status ?? 'not_attempted',
        writeBackError: result.write_back_error ?? undefined,
        tags: result.tags ?? undefined,
        entities: result.entities ?? undefined,
    };
}
