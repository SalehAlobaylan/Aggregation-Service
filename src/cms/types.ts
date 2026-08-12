/**
 * CMS API type definitions
 */

// Content types - must match queue schemas
export type ContentType =
  "NEWS" | "ARTICLE" | "VIDEO" | "TWEET" | "COMMENT" | "PODCAST";
export type SourceType =
  | "RSS"
  | "WEBSITE"
  | "TELEGRAM"
  | "PODCAST"
  | "PODCAST_DISCOVERY"
  | "YOUTUBE"
  | "TWITTER"
  | "REDDIT"
  | "UPLOAD"
  | "MANUAL";
export type ContentStatus =
  "PENDING" | "PROCESSING" | "READY" | "FAILED" | "ARCHIVED";

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
  source: "youtube" | "derived";
}

/** Transcript provenance written to CMS — drives content_item.caption_state. */
export type TranscriptSource =
  "youtube_human" | "youtube_auto" | "stt_deepgram" | "stt_whisper";

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
  content_language?: "ar" | "en" | null;

  author?: string | null;
  source_name: string;
  source_feed_url?: string | null;
	tenant_id?: string;
	content_source_id?: string;
	source_run_request_id?: string;
  original_url: string;

  media_url?: string | null;
  thumbnail_url?: string | null;
  duration_sec?: number | null;

  topic_tags?: string[];
  metadata?: Record<string, unknown>;

  published_at?: string | null;
  recovery_run_id?: string;
  recovery_manifest_hash?: string;
}

export interface CreateContentItemResponse {
  id: string;
  status: ContentStatus;
  created: boolean; // true if newly created, false if already existed
	retired?: boolean; // identity is a Retention tombstone; never enqueue downstream work
  created_at: string;
}

/**
 * PUT /internal/content-items/:id
 */
export interface UpdateContentItemRequest {
  title?: string;
  body_text?: string | null;
  excerpt?: string | null;
  content_language?: "ar" | "en" | null;
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
  feed_visibility?: string;
  chaptering_status?: string;
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
  playback_url?: string;
  playback_type?: "hls" | "mp4" | "audio" | string;
  fallback_playback_url?: string;
  has_video?: boolean;
  media_renditions?: MediaRendition[];
  media_suitability?:
    | "audio_first_talking_head"
    | "audio_first_show"
    | "visual_dependent"
    | "unsuitable"
    | "unknown"
    | string;
  media_suitability_confidence?: number;
  media_suitability_reasons?: string[];
  // Quality bookkeeping. Originals are write-once at first ingest.
  original_size_bytes?: number;
  original_bitrate_kbps?: number;
  current_bitrate_kbps?: number;
  current_quality_profile_id?: number;
  // Download-time signals merged into content_item.metadata jsonb (heatmap,
  // sponsor_segments, categories). Merged server-side — existing keys preserved.
  metadata?: Record<string, unknown>;
  // CMS-issued item-version fence for an exact Pipeline repair. Normal
  // ingestion must not synthesize this value.
  expected_item_updated_at?: string;
}

export interface MediaRendition {
  type: "hls" | "mp4" | "audio" | string;
  url: string;
  // The producing worker knows whether this exact rendition carries video.
  // Preserve that truth so consumers never infer a fallback player from URL.
  has_video?: boolean;
  mime_type?: string;
  width?: number;
  height?: number;
  bitrate_kbps?: number;
  is_primary?: boolean;
}

export interface AtomizationPolicy {
  chaptering_enabled: boolean;
  auto_publish_high_confidence: boolean;
  parent_feed_visible: boolean;
  preserve_video: boolean;
  remove_sponsor_segments: boolean;
  min_chapter_minutes: number;
  min_feed_unit_seconds?: number;
  soft_max_chapter_minutes: number;
  hard_max_chapter_minutes: number;
  atomization_min_parent_seconds?: number;
  max_chapters_per_parent: number;
  chaptering_mode: string;
  high_confidence_threshold: number;
  preferred_playback_rendition: string;
  fallback_playback_rendition: string;
  audio_only_allowed: boolean;
}

export interface AtomizationSegment {
  start: number;
  end: number;
  text: string;
}

export interface AtomizationChapter {
  title: string;
  summary?: string | null;
  start_ms: number;
  end_ms: number;
  confidence?: number;
  context_label?: string | null;
  boundary_reason?: string | null;
  // Set only by deterministic mergeChapterPair execution; LLM boundary prose
  // is diagnostic data and never authorizes the merged_short review code.
  merged_short_provenance?: boolean;
  standalone_score?: number;
  contains_sponsor_intro?: boolean;
  needs_review_reason?: string | null;
  // Stage 6 (S4/S5): normalized review-reason codes emitted alongside the
  // free text so the CMS Studio Autopilot trust gate keys on a fixed taxonomy.
  needs_review_code?: string | null;
  needs_review_codes?: string[];
  media_url?: string;
  thumbnail_url?: string;
  playback_url?: string;
  playback_type?: string;
  fallback_playback_url?: string;
  has_video?: boolean;
  media_renditions?: MediaRendition[];
  transcript_segments?: AtomizationSegment[];
  transcript_text?: string;
}

export interface AtomizationInputResponse {
  item: {
    id: string;
    tenant_id: string;
    type: ContentType;
    title?: string | null;
    source: SourceType;
    source_name?: string | null;
    source_feed_url?: string | null;
    media_url?: string | null;
    thumbnail_url?: string | null;
    playback_url?: string | null;
    fallback_playback_url?: string | null;
    storage_tier?: string | null;
    media_version?: number | null;
    duration_sec?: number | null;
    original_url?: string | null;
    has_video?: boolean | null;
  };
  policy: AtomizationPolicy;
  effective_policy?: AtomizationPolicy;
  policy_source?: "tenant" | "source" | "episode" | string;
  atomization_disabled_reason?: string | null;
  manual_requested?: boolean;
  transcript?: {
    transcript_id: string;
    full_text: string;
    language?: string | null;
    segments: AtomizationSegment[];
  };
  segments: AtomizationSegment[];
  sponsor_segments?: { start: number; end: number; category: string }[];
  existing_chapters: unknown[];
}

export interface AtomizedChildResponse {
  id: string;
  status: string;
  feed_visibility: string;
}

export interface AtomizationCandidate {
  id: string;
  tenant_id: string;
  type: ContentType;
  title?: string | null;
  source_name?: string | null;
  duration_sec?: number | null;
  chaptering_status?: string | null;
  transcript_id?: string | null;
  existing_child_count: number;
  media_url?: string | null;
  thumbnail_url?: string | null;
  excerpt?: string | null;
  body_text?: string | null;
}

export interface ListAtomizationCandidatesResponse {
  items: AtomizationCandidate[];
  transcript_candidates?: AtomizationCandidate[];
}

export interface AtomizationRepairResponse {
  updated_count: number;
  remaining_count: number;
  hidden_duration_violation_count?: number;
  archived_short_parent_child_count?: number;
  restored_parent_count?: number;
  restored_fuzzy_chapter_count?: number;
  remaining_visible_under_floor_count?: number;
  remaining_visible_over_hard_max_count?: number;
}

export interface AtomizationRunReportRequest {
  run_id?: string;
  status: "queued" | "running" | "completed" | "needs_review" | "failed";
  phase: "planning" | "cutting" | "renditions" | "children" | "embedding";
  child_count?: number;
  review_count?: number;
  error_message?: string;
  trigger?: "manual" | "reatomize" | "sweeper" | string;
  requested_by?: string;
}

export interface AtomizationRunReportResponse {
  run_id: string;
  status: string;
  phase: string;
}

// =============================================================================
// Storage Operations Telemetry — types matching CMS internal endpoints
// =============================================================================

export interface OpMetricItem {
  tier: "primary" | "cold";
  op_class: "A" | "B";
  op_type:
    | "PUT"
    | "GET"
    | "HEAD"
    | "DELETE"
    | "DELETE_OBJECTS"
    | "LIST"
    | "COPY"
    | "OTHER";
  count: number;
}

export interface WriteOpMetricsRequest {
  source: "internal" | "cloudflare";
  /** YYYY-MM-DD */
  date: string;
  tenant_id?: string;
  items: OpMetricItem[];
}

export interface OpBudgetStatus {
  class_a_status: "ok" | "warn" | "cap";
  class_b_status: "ok" | "warn" | "cap";
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
  status?: ContentStatus;
  type?: ContentType;
  is_feed_unit?: boolean;
  title?: string | null;
  excerpt?: string | null;
  source_name?: string | null;
  parent_content_item_id?: string | null;
  feed_visibility?: string;
  chaptering_status?: string | null;
  /** Empty string when the source is unknown / not applicable. */
  source_type: string;
  media_url?: string | null;
  thumbnail_url?: string | null;
  storage_state?: string | null;
  storage_state_reason?: string | null;
  storage_recovery_status?: string | null;
  storage_tier?: string | null;
  media_version: number;
  file_size_bytes: number;
  current_quality_profile_id?: number | null;
  current_bitrate_kbps?: number | null;
  duration_sec?: number | null;
  media_suitability?: string;
  media_suitability_confidence?: number | null;
  media_suitability_reasons?: unknown;
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
  video_codec: "h264" | "h265" | "av1";
  max_height: number;
  target_bitrate_kbps: number;
  crf: number;
  preset: string;
  audio_codec: "aac" | "opus";
  audio_bitrate_kbps: number;

  // Output container — drives the file extension chosen by the worker.
  output_container: "mp4" | "webm" | "mov";

  // Thumbnail extraction params.
  thumbnail_offset_seconds: number;
  thumbnail_max_height: number;

  // Input pre-flight constraints. Empty / null array = accept anything.
  allowed_input_mime_types?: string[] | null;
  max_input_size_bytes?: number | null;
  max_input_duration_sec?: number | null;

  is_active: boolean;
  preset_key?: string;
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
  old_media_url?: string;
  old_size_bytes?: number;
  old_storage_key?: string;
  new_storage_key?: string;
  event_reason?: string;
}

export interface UpdateContentItemQualityResponse {
  success: boolean;
  media_version: number;
}

export interface StorageArtifactEventRequest {
  tenant_id?: string;
  content_item_id: string;
  parent_content_item_id?: string | null;
  event_type: string;
  status?: "success" | "skipped" | "error" | "approval_required" | string;
  reason?: string;
  trigger?: string;
  source?: string;
  storage_tier?: string;
  old_storage_tier?: string;
  old_media_url?: string;
  new_media_url?: string;
  old_size_bytes?: number;
  new_size_bytes?: number;
  freed_bytes?: number;
  deleted_bytes?: number;
  quality_profile_id?: number;
  artifact_keys?: unknown;
  recovery_payload?: unknown;
  error?: string;
  created_by?: string;
  storage_state?: string;
  storage_state_reason?: string;
  storage_recovery_status?: string;
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
  transcription_job_id?: string;
  language_probability?: number;
  duration_sec?: number;
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
  job_id?: string;
  status?: string;
  reason?: string;
  error?: string;
}

export interface UpdateTranscriptionJobRequest {
  status?:
    | "queued"
    | "running"
    | "skipped"
    | "succeeded"
    | "failed"
    | "writeback_failed"
    | "canceled";
  error_message?: string;
  provider_error_code?: string;
  media_job_id?: string;
  writeback_status?: string;
  writeback_error?: string;
  actual_cost_usd?: number;
}

/**
 * Storage management types — talk to /internal/storage/*
 */
export interface StoragePolicy {
  id: number;
  tenant_id: string | null;
  enabled: boolean;
  preset?:
    | "balanced"
    | "conservative"
    | "storage_saver"
    | "critical_pressure"
    | string;
  max_storage_bytes: number;
  target_utilization_pct: number;
  min_age_days: number;
  min_view_count_for_keep: number;
  sweep_interval_minutes: number;
  delete_failed_immediately: boolean;
  preserve_thumbnails: boolean;
  protect_top_n_by_views: number;
  protect_top_n_window_days: number;
  archive_action: "delete" | "move_to_cold" | "re_encode";
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
  /** Tenants where the Media Circulation Autopilot is enabled (stage 5,
   *  single-actor rule): the repeatable auto-sweep defers for these tenants;
   *  Autopilot runs trigger bounded sweeps instead. Manual sweeps unaffected. */
  autopilot_tenants?: string[];
}

export interface StorageCandidate {
  id: string;
  tenant_id?: string;
  type: string;
  status: string;
  title?: string;
  source_name?: string;
  media_url?: string;
  thumbnail_url?: string;
  file_size_bytes: number;
  view_count: number;
  created_at: string;
  published_at?: string;
  parent_content_item_id?: string;
  is_feed_unit?: boolean;
  feed_visibility?: string;
  duration_sec?: number;
  original_url?: string;
  source_feed_url?: string;
  source_episode_id?: string;
  media_suitability?: string;
  content_role?:
    | "hot_feed_unit"
    | "normal_feed_unit"
    | "dormant_feed_unit"
    | "atomized_parent_source"
    | "unsuitable_media"
    | "failed_or_orphan_artifact"
    | string;
  protection_reason?: string;
}

export interface ListStorageCandidatesResponse {
  data: StorageCandidate[];
  total: number;
  total_bytes: number;
}

export interface ArchiveItemsRequest {
  ids: string[];
  preserve_thumbnails: boolean;
  tenant_id: string;
  idempotency_key?: string;
  manifest_hash?: string;
  correlation_id?: string;
  owner_request_id?: string;
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
  tenant_id: string;
  idempotency_key?: string;
  manifest_hash?: string;
  correlation_id?: string;
  owner_request_id?: string;
}

export interface MoveToColdResponse {
  updated_count: number;
  freed_bytes: number;
}

export interface StartStorageOperationSagaRequest {
  tenant_id: string;
  content_item_id: string;
  operation: "recoverable_delete" | "move_to_cold";
  idempotency_key: string;
  manifest_hash?: string;
  correlation_id?: string;
  owner_request_id?: string;
  evidence?: Record<string, unknown>;
}

export interface StorageOperationSaga {
  id: string;
  state: "prepared" | "object_applied" | "cms_committed" | string;
	created: boolean;
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
  correlation_id?: string;
  owner_request_id?: string;
  idempotency_key?: string;
  manifest_hash?: string;
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

// =============================================================================
// News Circulation — internal CMS API shapes
// =============================================================================

export interface NewsCirculationPolicy {
  tenant_id: string;
  preset: string;
  timezone: string;
  source_cadence_mode: "suggest" | "auto_apply" | "manual";
  source_claim_interval_minutes: number;
  source_min_interval_minutes: number;
  source_max_interval_minutes: number;
  source_max_change_percent: number;
}

export interface CirculationSourceClaim {
  id: string;
  name: string;
  type: SourceType;
  url: string;
  fetch_interval_minutes: number;
  settings?: Record<string, unknown>;
	source_run_request_id?: string;
}

export interface ClaimCirculationSourcesResponse {
  data: CirculationSourceClaim[];
  policy: NewsCirculationPolicy;
}

export interface MediaCirculationClaimPolicy {
  tenant_id: string;
  enabled: boolean;
  source_min_interval_minutes: number;
  source_max_interval_minutes: number;
  max_intake_per_source_per_cycle: number;
  max_intake_per_cycle: number;
}

export interface ClaimMediaCirculationSourcesResponse {
  data: CirculationSourceClaim[];
  policy: MediaCirculationClaimPolicy;
}

export interface ReportSourceRunRequest {
  tenant_id?: string;
  source_id: string;
	source_run_request_id?: string;
  job_id: string;
  triggered_by: "schedule" | "manual";
  fetched?: number;
  accepted?: number;
  duplicates?: number;
  filtered?: number;
  failed?: number;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
}
