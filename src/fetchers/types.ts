/**
 * Fetcher types and interfaces
 */
import type { SourceType } from '../queues/schemas.js';

/**
 * Raw item fetched from a source
 */
export interface RawFetchedItem {
    externalId: string;
    sourceType: SourceType;
    url: string;
    title: string;
    content?: string;
    excerpt?: string;
    author?: string;
    publishedAt?: string;
    thumbnailUrl?: string;
    duration?: number;
    engagement?: EngagementMetrics;
    metadata: Record<string, unknown>;
    fetchedAt: string;
}

/**
 * Engagement metrics for social content
 */
export interface EngagementMetrics {
    likes?: number;
    shares?: number;
    comments?: number;
    views?: number;
    score?: number;
}

/**
 * Fetch result from a source
 */
export interface FetchResult {
    items: RawFetchedItem[];
    cursor?: string;           // For pagination
    hasMore: boolean;
    metadata: {
        totalFetched: number;
        skipped: number;
        errors: number;
    };
}

/**
 * Source configuration for fetching
 */
export interface SourceConfig {
    id: string;
    type: SourceType;
    name: string;
    url: string;                    // Feed URL, channel ID, etc.
    enabled: boolean;
    pollIntervalMs: number;         // How often to poll
    settings: Record<string, unknown>;
}

/**
 * Fetcher interface - all fetchers must implement this
 */
export interface Fetcher {
    sourceType: SourceType;
    fetch(config: SourceConfig, cursor?: string): Promise<FetchResult>;
}

/**
 * YouTube-specific config
 */
export interface YouTubeSourceConfig extends SourceConfig {
    type: 'YOUTUBE';
    settings: {
        channelId?: string;
        playlistId?: string;
        maxResults?: number;
    };
}

/**
 * Reddit-specific config
 */
export interface RedditSourceConfig extends SourceConfig {
    type: 'REDDIT';
    settings: {
        subreddit: string;
        sortBy?: 'hot' | 'new' | 'top' | 'rising';
        minScore?: number;
        limit?: number;
    };
}

/**
 * Twitter-specific config
 */
export interface TwitterSourceConfig extends SourceConfig {
    type: 'TWITTER';
    settings: {
        searchQuery?: string;
        userId?: string;
        mode: 'api' | 'scrape';
        minEngagement?: number;
    };
}
