/**
 * AI module exports.
 *
 * All model-backed AI work is performed by external services:
 *   - Media-Service:      Whisper transcription, CLIP image embedding.
 *   - Enrichment-Service: text embeddings, topic tags, LLM-backed ops.
 *
 * Aggregation only assembles input text and makes HTTP calls — there are no
 * local model dependencies anymore.
 */
export {
    transcribeViaMedia,
    transcribeAsyncViaMedia,
    submitTranscribeJobViaMedia,
    getTranscribeJobStatusViaMedia,
    embedImageViaMedia,
    type TranscriptResult,
    type TranscriptSegment,
    type TranscribeJobStatus,
    type ImageEmbedResult,
} from './media-client.js';

export {
    generateEmbeddingViaEnrichment,
    type EmbedResult,
} from './enrichment-client.js';

export { buildEmbeddingText } from './embeddings.js';
