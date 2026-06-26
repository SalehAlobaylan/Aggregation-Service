/**
 * Queue job type definitions
 */

// Source types
export type SourceType =
    'RSS'
    | 'WEBSITE'
    | 'TELEGRAM'
    | 'YOUTUBE'
    | 'PODCAST'
    | 'PODCAST_DISCOVERY'
    | 'TWITTER'
    | 'REDDIT'
    | 'UPLOAD'
    | 'MANUAL';

// Content types. NEWS is the CMS-side primary kind (with a `format` sub-type);
// Aggregation still normalizes to the legacy ARTICLE/TWEET/COMMENT shapes and
// CMS folds them into NEWS+format at the ingest boundary. NEWS appears here for
// the reconcile read-back path, which reads `type` straight from CMS.
export type ContentType = 'NEWS' | 'ARTICLE' | 'VIDEO' | 'TWEET' | 'COMMENT' | 'PODCAST';

// Content status
export type ContentStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'ARCHIVED';

/**
 * Fetch Job - triggers content fetching from a source
 */
export interface FetchJob {
    sourceId: string;
    sourceType: SourceType;
    config: Record<string, unknown>;
    triggeredBy: 'schedule' | 'manual';
    triggeredAt: string;
}

/**
 * Normalize Job - normalizes raw content to canonical format
 */
export interface NormalizeJob {
    sourceId: string;
    sourceType: SourceType;
    rawItems: RawItem[];
    fetchJobId: string;
    triggeredBy?: 'schedule' | 'manual';
    sourceSettings?: Record<string, unknown>;
}

export interface RawItem {
    externalId: string;
    rawData: Record<string, unknown>;
    fetchedAt: string;
}

/**
 * Media Job - handles media download, transcoding, and upload
 */
export interface MediaJob {
    contentItemId: string;
    contentType: ContentType;
    sourceType: SourceType;
    sourceUrl: string;
    // Content text captured during normalization. Forwarded to the AI job after
    // media processing so video/podcast embeddings include title/description.
    textContent?: {
        title: string;
        excerpt?: string;
        bodyText?: string;
    };
    downloadRef?: {
        channelUsername: string;
        channelId?: string;
        messageId: number;
        mediaKind: 'audio' | 'voice' | 'video' | 'photo';
        fileName?: string;
        mimeType?: string;
    };
    operations: ('download' | 'transcode' | 'thumbnail')[];
}

/**
 * AI Job - handles transcript, embedding, and image-embedding generation
 */
export interface AIJob {
    contentItemId: string;
    contentType: ContentType;
    operations: ('transcript' | 'embedding')[];
    textContent: {
        title: string;
        excerpt?: string;
        bodyText?: string;
    };
    mediaPath?: string; // For transcript generation
    mediaUrl?: string;  // For transcript generation via remote URL
    // Hero image / video thumbnail URL — when set, the AI worker also runs
    // CLIP image embedding via Enrichment (best-effort, non-blocking).
    heroImageUrl?: string;
    // Caption-first: when the media worker extracted a YouTube caption it writes
    // it to CMS and passes the state here. 'youtube_human' → skip STT entirely;
    // 'youtube_auto'/'none' → ask CMS to (maybe) upgrade via STT (guard-gated).
    // captionText feeds embedding so caption items embed with their text even
    // though STT (if any) runs asynchronously.
    captionState?: 'youtube_human' | 'youtube_auto' | 'none';
    captionText?: string;
}

/**
 * Storage Sweep Job - one circulation tick for one tenant
 */
export interface StorageSweepJob {
    tenantId: string;
    trigger: 'auto' | 'manual';
}

/**
 * Reconcile Job - one sweep tick that re-enqueues embedding-only AI jobs for
 * READY content items still missing a dense embedding (the H2 backstop for
 * items where the original AI job exhausted retries, plus historical rows).
 */
export interface ReconcileJob {
    trigger: 'auto' | 'manual';
}

/**
 * Quality Re-encode Job - one item, one target profile.
 * Workflow: download → ffprobe → ffmpeg(profile) → upload to versioned key →
 * patch CMS → schedule grace-period cleanup of the prior key.
 */
export interface QualityReencodeJob {
    contentItemId: string;
    targetProfileId: number;
    tenantId: string;
    ruleId?: number;
    trigger: 'manual' | 'rule' | 'ingest';
}

/**
 * Quality cleanup job — delayed deletion of the old versioned media key
 * once the URL swap has propagated past any in-flight reads.
 */
export interface QualityCleanupJob {
    contentItemId: string;
    keyToDelete: string;
    tier: 'primary' | 'cold';
}

// QualitySweepJob removed in Phase 7 — re-encoding old content is now
// orchestrated by the storage sweep worker (when archive_action='re_encode'),
// which enqueues directly onto QUALITY_REENCODE.

/**
 * Discovery Job - hunts the open web for new news sources matching a profile,
 * validates them, and posts candidates back to CMS for admin review.
 */
export interface DiscoveryProfileInput {
    id: string; // CMS discovery_profiles.public_id
    name: string;
    description?: string;
    keywords?: string[];
    languages?: string[];
    maxSuggestionsPerRun?: number;
    tenantId?: string;
    // Category ('news' | 'media') routes the sweep to the right keyword provider:
    // media profiles discover podcasts via iTunes instead of the news web search.
    category?: string;
    // Config-driven overrides (from CMS discovery_config) so scheduled and manual
    // runs share the same tuning.
    recencyDays?: number;
    searchProvider?: string; // 'auto' | 'tavily' | 'crawl'
}

export interface DiscoveryJob {
    profile: DiscoveryProfileInput;
    triggeredBy: 'schedule' | 'manual';
}

// Discovery Sweep Job — the repeatable that fans out a DiscoveryJob per enabled
// profile on the configured interval.
export interface DiscoverySweepJob {
    trigger: 'auto' | 'manual';
}

// Source Graph Job — the repeatable that rebuilds the source-intelligence graph.
export interface SourceGraphJob {
    trigger: 'auto' | 'manual';
}

// News Circulation Job — claims due CMS news sources and enqueues fetch jobs.
export interface NewsCirculationJob {
    trigger: 'auto' | 'manual';
    tenantId?: string;
}

/**
 * DLQ Job - failed job moved to dead letter queue
 */
export interface DLQJob {
    originalQueue: string;
    originalJobId: string;
    originalJobData: unknown;
    failureReason: string;
    failedAt: string;
    attemptsMade: number;
}

// Queue names
export const QUEUE_NAMES = {
    FETCH: 'fetch-queue',
    NORMALIZE: 'normalize-queue',
    MEDIA: 'media-queue',
    AI: 'ai-queue',
    STORAGE_SWEEP: 'storage-sweep-queue',
    RECONCILE: 'reconcile-queue',
    QUALITY_REENCODE: 'quality-reencode-queue',
    DISCOVERY: 'discovery-queue',
    DISCOVERY_SWEEP: 'discovery-sweep-queue',
    SOURCE_GRAPH: 'source-graph-queue',
    NEWS_CIRCULATION: 'news-circulation-queue',
    DLQ: 'aggregation-dlq',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];
