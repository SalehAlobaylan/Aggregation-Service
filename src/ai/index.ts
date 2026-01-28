/**
 * AI module exports
 */
export {
    whisperClient,
    transcribe,
    transcribeWithTimestamps,
    detectLanguage,
    type TranscriptResult,
    type TranscriptSegment,
} from './whisper.js';

export {
    embeddingService,
    buildEmbeddingText,
    generateEmbedding,
    generateEmbeddingsBatch,
    warmupEmbeddingModel,
} from './embeddings.js';
