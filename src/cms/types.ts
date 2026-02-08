/**
 * CMS API type definitions
 */

// Content types - must match queue schemas
export type ContentType = 'ARTICLE' | 'VIDEO' | 'TWEET' | 'COMMENT' | 'PODCAST';
export type SourceType = 'RSS' | 'PODCAST' | 'PODCAST_DISCOVERY' | 'YOUTUBE' | 'TWITTER' | 'REDDIT' | 'UPLOAD' | 'MANUAL';
export type ContentStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'ARCHIVED';

/**
 * ContentItem - canonical content record in CMS
 */
export interface ContentItem {
    id: string;
    idempotency_key: string;
    type: ContentType;
    source: SourceType;
    status: ContentStatus;

    title: string;
    body_text: string | null;
    excerpt: string | null;

    author: string | null;
    source_name: string;
    source_feed_url: string | null;

    media_url: string | null;
    thumbnail_url: string | null;
    original_url: string;
    duration_sec: number | null;

    topic_tags: string[];
    embedding: number[];
    metadata: Record<string, unknown>;

    published_at: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * Transcript record
 */
export interface Transcript {
    id: string;
    content_item_id: string;
    full_text: string;
    summary: string | null;
    word_timestamps: WordTimestamp[] | null;
    language: string;
    created_at: string;
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
    idempotency_key: string;
    type: ContentType;
    source: SourceType;
    status: ContentStatus;

    title: string;
    body_text?: string | null;
    excerpt?: string | null;

    author?: string | null;
    source_name: string;
    source_feed_url?: string | null;
    original_url: string;

    media_url?: string | null;
    thumbnail_url?: string | null;
    duration_sec?: number | null;

    topic_tags?: string[];
    metadata?: Record<string, unknown>;

    published_at?: string | null;
}

export interface CreateContentItemResponse {
    id: string;
    status: ContentStatus;
    created: boolean; // true if newly created, false if already existed
    created_at: string;
}

/**
 * PUT /internal/content-items/:id
 */
export interface UpdateContentItemRequest {
    title?: string;
    body_text?: string | null;
    excerpt?: string | null;
    author?: string | null;
    source_name?: string;
    source_feed_url?: string | null;
    original_url?: string;
    published_at?: string | null;
    metadata?: Record<string, unknown>;
}

/**
 * PATCH /internal/content-items/:id/status
 */
export interface UpdateStatusRequest {
    status: ContentStatus;
    failure_reason?: string;
}

/**
 * PATCH /internal/content-items/:id/artifacts
 */
export interface UpdateArtifactsRequest {
    media_url?: string;
    thumbnail_url?: string;
    duration_sec?: number;
}

/**
 * POST /internal/transcripts
 */
export interface CreateTranscriptRequest {
    content_item_id: string;
    full_text: string;
    summary?: string;
    word_timestamps?: WordTimestamp[];
    language: string;
}

export interface CreateTranscriptResponse {
    id: string;
    created_at: string;
}

/**
 * PATCH /internal/content-items/:id/transcript
 */
export interface LinkTranscriptRequest {
    transcript_id: string;
}

/**
 * PATCH /internal/content-items/:id/embedding
 */
export interface UpdateEmbeddingRequest {
    embedding: number[];
    topic_tags?: string[];
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
