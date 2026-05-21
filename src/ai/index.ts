/**
 * AI module exports.
 *
 * All model-backed AI work (Whisper transcription, sentence embeddings) is
 * performed by Enrichment-Service. Aggregation only assembles input text and
 * makes HTTP calls — there are no local model dependencies anymore.
 */
export {
    transcribeViaEnrichment,
    generateEmbeddingViaEnrichment,
    type TranscriptResult,
    type TranscriptSegment,
} from './enrichment-client.js';

export { buildEmbeddingText } from './embeddings.js';
