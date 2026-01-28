/**
 * Embedding Generator
 * Uses transformers.js for all-MiniLM-L6-v2 (384-dim vectors)
 */
import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';
import { logger } from '../observability/logger.js';

// Model configuration
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;
const MAX_TEXT_LENGTH = 8192; // Characters

// Singleton pipeline instance
let embeddingPipeline: FeatureExtractionPipeline | null = null;
let isLoading = false;
let loadPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Initialize the embedding model (lazy load)
 */
async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
    if (embeddingPipeline) {
        return embeddingPipeline;
    }

    if (isLoading && loadPromise) {
        return loadPromise;
    }

    isLoading = true;
    logger.info('Loading embedding model', { model: MODEL_NAME });

    loadPromise = pipeline('feature-extraction', MODEL_NAME, {
        quantized: true, // Use quantized model for faster inference
    }) as Promise<FeatureExtractionPipeline>;

    try {
        embeddingPipeline = await loadPromise;
        logger.info('Embedding model loaded successfully');
        return embeddingPipeline;
    } finally {
        isLoading = false;
        loadPromise = null;
    }
}

/**
 * Build text for embedding from content fields
 */
export function buildEmbeddingText(
    title: string,
    excerpt?: string | null,
    bodyText?: string | null,
    transcript?: string | null
): string {
    const parts: string[] = [title];

    // Prefer transcript for video/podcast, otherwise use body
    if (transcript) {
        // Take first portion of transcript
        parts.push(transcript.substring(0, 2000));
    } else if (bodyText) {
        parts.push(bodyText.substring(0, 2000));
    }

    if (excerpt && excerpt !== bodyText?.substring(0, excerpt.length)) {
        parts.push(excerpt);
    }

    const combined = parts.join(' ').trim();

    // Truncate to max length
    return combined.substring(0, MAX_TEXT_LENGTH);
}

/**
 * Generate 384-dimension embedding for text
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
        logger.warn('Empty text provided for embedding');
        return new Array(EMBEDDING_DIM).fill(0);
    }

    const truncatedText = text.substring(0, MAX_TEXT_LENGTH);

    logger.debug('Generating embedding', { textLength: truncatedText.length });

    try {
        const extractor = await getEmbeddingPipeline();

        // Generate embedding
        const output = await extractor(truncatedText, {
            pooling: 'mean',
            normalize: true,
        });

        // Convert to array
        const embedding = Array.from(output.data as Float32Array);

        // Validate dimension
        if (embedding.length !== EMBEDDING_DIM) {
            logger.error('Unexpected embedding dimension', {
                expected: EMBEDDING_DIM,
                actual: embedding.length,
            });
            throw new Error(`Invalid embedding dimension: ${embedding.length}`);
        }

        logger.debug('Embedding generated', {
            textLength: truncatedText.length,
            embeddingDim: embedding.length,
        });

        return embedding;
    } catch (error) {
        logger.error('Embedding generation failed', error);
        throw error;
    }
}

/**
 * Generate embeddings for multiple texts (batch processing)
 */
export async function generateEmbeddingsBatch(
    texts: string[]
): Promise<number[][]> {
    const results: number[][] = [];

    for (const text of texts) {
        const embedding = await generateEmbedding(text);
        results.push(embedding);
    }

    return results;
}

/**
 * Pre-warm the embedding model
 */
export async function warmupEmbeddingModel(): Promise<void> {
    logger.info('Warming up embedding model...');
    await getEmbeddingPipeline();
    // Generate a test embedding to ensure model is fully loaded
    await generateEmbedding('test warmup');
    logger.info('Embedding model warmed up');
}

export const embeddingService = {
    buildEmbeddingText,
    generateEmbedding,
    generateEmbeddingsBatch,
    warmupEmbeddingModel,
    EMBEDDING_DIM,
};
