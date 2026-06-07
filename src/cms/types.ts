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

/** Timestamped transcript segment ([{start,end,text}]). */
export interface TranscriptSegment {
    start: number;
    end: number;
    text: string;
}

/** Chapter marker. `source`: 'youtube' (native) or 'derived' (future LLM). */
export interface TranscriptChapter {
    start: number;
    end: number;
    title: string;
    source: 'youtube' | 'derived';
}

/** Transcript provenance written to CMS — drives content_item.caption_state. */
export type TranscriptSource =
    | 'youtube_human'
    | 'youtube_auto'
    | 'stt_deepgram'
    | 'stt_whisper';

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
// Storage Operations Telemetry — types matching CMS internal endpoints
// =============================================================================

export interface OpMetricItem {
    tier: 'primary' | 'cold';
    op_class: 'A' | 'B';
    op_type: 'PUT' | 'GET' | 'HEAD' | 'DELETE' | 'DELETE_OBJECTS' | 'LIST' | 'COPY' | 'OTHER';
    count: number;
}

export interface WriteOpMetricsRequest {
    source: 'internal' | 'cloudflare';
    /** YYYY-MM-DD */
    date: string;
    tenant_id?: string;
    items: OpMetricItem[];
}

export interface OpBudgetStatus {
    class_a_status: 'ok' | 'warn' | 'cap';
    class_b_status: 'ok' | 'warn' | 'cap';
    class_a_used: number;
    class_b_used: number;
    class_a_remaining: number;
    class_b_remaining: number;
    class_a_budget: number;
    class_b_budget: number;
}

/**
 * GET /internal/content-items/:id — full record needed by the quality worker.
 * Distinct from the list-shape `internalListContentItemResponse`; this carries
 * tier + media_version + current quality profile so the worker can derive
 * source key, destination tier, and next versioned key.
 */
export interface InternalContentItem {
    id: string;
    tenant_id: string;
    /** Empty string when the source is unknown / not applicable. */
    source_type: string;
    media_url?: string | null;
    thumbnail_url?: string | null;
    storage_tier?: string | null;
    media_version: number;
    file_size_bytes: number;
    current_quality_profile_id?: number | null;
    current_bitrate_kbps?: number | null;
    duration_sec?: number | null;
}

// =============================================================================
// Quality / Ingest Configuration — types matching CMS internal endpoints
//
// Phase 7: collapsed to just the surface Aggregation needs — fetch a profile
// by id, resolve a profile for (tenant, source_type), and patch per-item
// quality fields after a re-encode. All rule/candidate/history shapes are
// gone (re-encoding is now driven by Storage policies, not Quality rules).
// =============================================================================

export interface QualityProfile {
    id: number;
    tenant_id?: string | null;
    source_type?: string | null;
    name: string;
    description: string;

    // Encode params
    video_codec: 'h264' | 'h265' | 'av1';
    max_height: number;
    target_bitrate_kbps: number;
    crf: number;
    preset: string;
    audio_codec: 'aac' | 'opus';
    audio_bitrate_kbps: number;

    // Output container — drives the file extension chosen by the worker.
    output_container: 'mp4' | 'webm' | 'mov';

    // Thumbnail extraction params.
    thumbnail_offset_seconds: number;
    thumbnail_max_height: number;

    // Input pre-flight constraints. Empty / null array = accept anything.
    allowed_input_mime_types?: string[] | null;
    max_input_size_bytes?: number | null;
    max_input_duration_sec?: number | null;

    is_active: boolean;
}

export interface ResolveProfileResponse {
    profile: QualityProfile;
    /** tenant+source | tenant | source | global */
    matched_on: string;
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
    // Caption-first additions. `segments` powers subtitles/seek + chunked
    // embeddings; `chapters` are native YouTube chapters; `source`/`provider`
    // set provenance (CMS maps source → caption_state).
    segments?: TranscriptSegment[];
    chapters?: TranscriptChapter[];
    source?: TranscriptSource;
    provider?: string;
}

export interface CreateTranscriptResponse {
    id: string;
    created_at: string;
}

/**
 * POST /internal/content-items/:id/request-stt
 * Guard-enforced STT request (toggle + budget live in CMS). `force` bypasses
 * the toggle/state-machine for a manual upgrade (budget cap still applies).
 */
export interface RequestSttResponse {
    triggered: boolean;
    reason?: string;
    error?: string;
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
    archive_action: 'delete' | 'move_to_cold' | 're_encode';
    /** When archive_action='re_encode', the QualityProfile to shrink down to.
     *  null = auto-pick the per-item resolved ingest profile. */
    re_encode_target_profile_id?: number | null;
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
    moved_to_cold_count?: number;
    re_encoded_count?: number;
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

/** One READY item still missing a dense embedding (reconciliation sweep). */
export interface MissingEmbeddingItem {
    id: string;
    type: string;
    title: string | null;
    excerpt: string | null;
    body_text: string | null;
    source_name: string | null;
    published_at: string | null;
}

export interface ListMissingEmbeddingResponse {
    items: MissingEmbeddingItem[];
}
