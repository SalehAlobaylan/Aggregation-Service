/**
 * Queue job type definitions
 */

// Source types
export type SourceType = 'RSS' | 'YOUTUBE' | 'PODCAST' | 'TWITTER' | 'REDDIT' | 'UPLOAD' | 'MANUAL';

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
    sourceUrl: string;
    operations: ('download' | 'transcode' | 'thumbnail')[];
}

/**
 * AI Job - handles transcript and embedding generation
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
    DLQ: 'aggregation-dlq',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];
