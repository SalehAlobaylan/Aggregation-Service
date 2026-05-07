/**
 * CMS API type definitions
 */

// Content types - must match queue schemas
export type ContentType = 'ARTICLE' | 'VIDEO' | 'TWEET' | 'COMMENT' | 'PODCAST';
export type SourceType = 'RSS' | 'WEBSITE' | 'TELEGRAM' | 'PODCAST' | 'PODCAST_DISCOVERY' | 'YOUTUBE' | 'TWITTER' | 'REDDIT' | 'UPLOAD' | 'MANUAL';
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
    file_size_bytes?: number;
    storage_tier?: string;
    // Quality bookkeeping. Originals are write-once at first ingest.
    original_size_bytes?: number;
    original_bitrate_kbps?: number;
    current_bitrate_kbps?: number;
    current_quality_profile_id?: number;
}

// =============================================================================
// Quality Management — types matching CMS internal endpoints
// =============================================================================

export interface QualityProfile {
    id: number;
    tenant_id?: string | null;
    name: string;
    description: string;
    video_codec: 'h264' | 'h265' | 'av1';
    max_height: number;
    target_bitrate_kbps: number;
    crf: number;
    preset: string;
    audio_codec: 'aac' | 'opus';
    audio_bitrate_kbps: number;
    is_default: boolean;
    is_active: boolean;
}

export interface QualityRule {
    id: number;
    tenant_id?: string | null;
    name: string;
    enabled: boolean;
    priority: number;
    min_age_days: number;
    max_view_count?: number | null;
    max_views_per_day?: number | null;
    content_type: string;
    source_id?: number | null;
    only_if_higher_than?: number | null;
    target_profile_id: number;
    sweep_interval_minutes: number;
    last_sweep_at?: string | null;
}

export interface QualityCandidateRef {
    content_item_id: string;
    storage_tier?: string | null;
    file_size_bytes: number;
    media_url?: string | null;
    media_version: number;
    current_quality_profile_id?: number | null;
}

export interface QualityCandidatesResponse {
    data: QualityCandidateRef[];
    target_profile_id: number;
    rule_id: number;
    tenant_id: string;
}

export interface WriteQualityHistoryRequest {
    content_item_id: string;
    tenant_id: string;
    from_profile_id?: number | null;
    to_profile_id: number;
    original_size_bytes: number;
    new_size_bytes: number;
    original_bitrate_kbps: number;
    new_bitrate_kbps: number;
    duration_ms: number;
    trigger: 'manual' | 'rule' | 'ingest';
    rule_id?: number | null;
    error?: string;
}

export interface UpdateContentItemQualityRequest {
    media_url?: string;
    file_size_bytes?: number;
    current_bitrate_kbps?: number;
    current_quality_profile_id?: number;
    bump_version?: boolean;
}

export interface UpdateContentItemQualityResponse {
    success: boolean;
    media_version: number;
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
 * Storage management types — talk to /internal/storage/*
 */
export interface StoragePolicy {
    id: number;
    tenant_id: string | null;
    enabled: boolean;
    max_storage_bytes: number;
    target_utilization_pct: number;
    min_age_days: number;
    min_view_count_for_keep: number;
    sweep_interval_minutes: number;
    delete_failed_immediately: boolean;
    preserve_thumbnails: boolean;
    protect_top_n_by_views: number;
    protect_top_n_window_days: number;
    archive_action: 'delete' | 'move_to_cold';
    last_sweep_at?: string;
    updated_at: string;
}

export interface ListStoragePoliciesResponse {
    global: StoragePolicy | null;
    overrides: StoragePolicy[];
    all: StoragePolicy[];
}

export interface StorageCandidate {
    id: string;
    tenant_id: string;
    type: string;
    status: string;
    media_url?: string;
    thumbnail_url?: string;
    file_size_bytes: number;
    view_count: number;
    created_at: string;
}

export interface ListStorageCandidatesResponse {
    data: StorageCandidate[];
    total: number;
    total_bytes: number;
}

export interface ArchiveItemsRequest {
    ids: string[];
    preserve_thumbnails: boolean;
}

export interface ArchiveItemsResponse {
    updated_count: number;
    freed_bytes: number;
}

export interface MoveToColdItem {
    id: string;
    media_url?: string;
    thumbnail_url?: string;
    new_size_bytes?: number;
}

export interface MoveToColdRequest {
    items: MoveToColdItem[];
}

export interface MoveToColdResponse {
    updated_count: number;
    freed_bytes: number;
}

export interface CreateSweepRunRequest {
    tenant_id: string;
    started_at: string;
    finished_at?: string;
    deleted_count: number;
    freed_bytes: number;
    trigger: string;
    error?: string;
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
 * GET /internal/content-items response item
 * Lightweight projection used for retry/requeue operations
 */
export interface InternalContentListItem {
    id: string;
    type: ContentType;
    source: SourceType;
    status: ContentStatus;
    original_url: string;
    metadata: Record<string, unknown>;
}

export interface InternalContentListResponse {
    data: InternalContentListItem[];
    total: number;
    page: number;
    limit: number;
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
