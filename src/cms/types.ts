/**
 * CMS API type definitions
 */

// Content types
export type ContentType = 'ARTICLE' | 'VIDEO' | 'TWEET' | 'COMMENT' | 'PODCAST';
export type SourceType = 'RSS' | 'PODCAST' | 'YOUTUBE' | 'UPLOAD' | 'MANUAL';
export type ContentStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'ARCHIVED';

/**
 * ContentItem - canonical content record in CMS
 */
export interface ContentItem {
    id: string;
    idempotencyKey: string;
    type: ContentType;
    source: SourceType;
    status: ContentStatus;

    title: string;
    bodyText: string | null;
    excerpt: string | null;

    author: string | null;
    sourceName: string;
    sourceFeedUrl: string | null;

    mediaUrl: string | null;
    thumbnailUrl: string | null;
    originalUrl: string;
    durationSec: number | null;

    topicTags: string[];
    embedding: number[];
    metadata: Record<string, unknown>;

    publishedAt: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * Transcript record
 */
export interface Transcript {
    id: string;
    contentItemId: string;
    fullText: string;
    summary: string | null;
    wordTimestamps: WordTimestamp[] | null;
    language: string;
    createdAt: string;
}

export interface WordTimestamp {
    word: string;
    start: number;
    end: number;
}

// API Request/Response types

/**
 * POST /internal/content-items
 */
export interface CreateContentItemRequest {
    idempotencyKey: string;
    type: ContentType;
    source: SourceType;
    status: 'PENDING';

    title: string;
    bodyText?: string;
    excerpt?: string;

    author?: string;
    sourceName: string;
    sourceFeedUrl?: string;
    originalUrl: string;

    publishedAt: string;
    metadata?: Record<string, unknown>;
}

export interface CreateContentItemResponse {
    id: string;
    status: 'PENDING';
    createdAt: string;
}

/**
 * PUT /internal/content-items/:id
 */
export interface UpdateContentItemRequest {
    title?: string;
    bodyText?: string;
    excerpt?: string;
    author?: string;
    sourceName?: string;
    sourceFeedUrl?: string;
    originalUrl?: string;
    publishedAt?: string;
    metadata?: Record<string, unknown>;
}

/**
 * PATCH /internal/content-items/:id/status
 */
export interface UpdateStatusRequest {
    status: 'PROCESSING' | 'READY' | 'FAILED';
    errorMessage?: string;
}

/**
 * PATCH /internal/content-items/:id/artifacts
 */
export interface UpdateArtifactsRequest {
    mediaUrl?: string;
    thumbnailUrl?: string;
    durationSec?: number;
}

/**
 * POST /internal/transcripts
 */
export interface CreateTranscriptRequest {
    contentItemId: string;
    fullText: string;
    summary?: string;
    wordTimestamps?: WordTimestamp[];
    language: string;
}

export interface CreateTranscriptResponse {
    id: string;
    createdAt: string;
}

/**
 * PATCH /internal/content-items/:id/transcript
 */
export interface LinkTranscriptRequest {
    transcriptId: string;
}

/**
 * PATCH /internal/content-items/:id/embedding
 */
export interface UpdateEmbeddingRequest {
    embedding: number[];
    topicTags?: string[];
}

/**
 * Generic API response wrapper
 */
export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
    };
}
