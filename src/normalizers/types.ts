/**
 * Normalizer types and interfaces
 */
import type { ContentType, ContentStatus, SourceType } from '../queues/schemas.js';
import type { RawFetchedItem } from '../fetchers/types.js';

/**
 * Normalized content item ready for CMS upsert
 */
export interface NormalizedItem {
    idempotencyKey: string;
    type: ContentType;
    source: SourceType;
    status: ContentStatus;

    // Core fields
    title: string;
    bodyText: string | null;
    excerpt: string | null;

    // Attribution
    author: string | null;
    sourceName: string;
    sourceFeedUrl: string | null;

    // Media
    mediaUrl: string | null;
    thumbnailUrl: string | null;
    originalUrl: string;
    durationSec: number | null;

    // Discovery
    topicTags: string[];
    metadata: Record<string, unknown>;

    // Timestamps
    publishedAt: Date | null;
}

/**
 * Normalizer interface - all normalizers must implement this
 */
export interface Normalizer {
    contentType: ContentType;
    sourceTypes: SourceType[];
    normalize(item: RawFetchedItem): NormalizedItem;
}

/**
 * Result of normalization for a batch
 */
export interface NormalizationResult {
    normalized: NormalizedItem[];
    skipped: number;
    errors: string[];
}
