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

// Content types
export type ContentType = 'ARTICLE' | 'VIDEO' | 'TWEET' | 'COMMENT' | 'PODCAST';

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
}

/**
 * Storage Sweep Job - one circulation tick for one tenant
 */
export interface StorageSweepJob {
    tenantId: string;
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
    QUALITY_REENCODE: 'quality-reencode-queue',
    DLQ: 'aggregation-dlq',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];
