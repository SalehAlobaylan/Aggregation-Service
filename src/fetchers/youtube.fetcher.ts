/**
 * YouTube Data API v3 Fetcher
 * Fetches video metadata from channels and playlists
 */
import { logger } from '../observability/logger.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { getRedisConnection } from '../queues/redis.js';
import type { Fetcher, FetchResult, RawFetchedItem, SourceConfig, YouTubeSourceConfig } from './types.js';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const QUOTA_KEY = 'youtube:quota:daily';

// YouTube API costs per endpoint
const QUOTA_COSTS = {
    search: 100,
    playlistItems: 1,
    videos: 1,
    channels: 1,
};

/**
 * Get YouTube API key from environment
 */
function getApiKey(): string {
    const key = process.env['YOUTUBE_API_KEY'];
    if (!key) {
        throw new Error('YOUTUBE_API_KEY environment variable is required');
    }
    return key;
}

/**
 * Track quota usage in Redis
 */
async function trackQuota(cost: number): Promise<boolean> {
    const redis = getRedisConnection();
    const today = new Date().toISOString().split('T')[0];
    const key = `${QUOTA_KEY}:${today}`;

    const current = await redis.get(key);
    const used = current ? parseInt(current) : 0;
    const limit = parseInt(process.env['YOUTUBE_QUOTA_LIMIT'] || '10000');

    if (used + cost > limit) {
        logger.warn('YouTube quota limit reached', { used, cost, limit });
        return false;
    }

    await redis.incrby(key, cost);
    await redis.expire(key, 86400 * 2); // 2 days TTL

    return true;
}

/**
 * Parse ISO 8601 duration to seconds
 */
function parseDuration(duration: string): number | undefined {
    if (!duration) return undefined;

    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return undefined;

    const hours = parseInt(match[1] || '0');
    const minutes = parseInt(match[2] || '0');
    const seconds = parseInt(match[3] || '0');

    return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Get best thumbnail URL
 */
function getBestThumbnail(thumbnails: Record<string, { url: string }>): string | undefined {
    const priorities = ['maxres', 'high', 'medium', 'standard', 'default'];
    for (const key of priorities) {
        if (thumbnails[key]?.url) {
            return thumbnails[key].url;
        }
    }
    return undefined;
}

export const youtubeFetcher: Fetcher = {
    sourceType: 'YOUTUBE',

    async fetch(config: SourceConfig, cursor?: string): Promise<FetchResult> {
        const ytConfig = config as YouTubeSourceConfig;
        const { channelId, playlistId, maxResults = 20 } = ytConfig.settings;

        const items: RawFetchedItem[] = [];
        let nextCursor: string | undefined;

        // Check rate limit
        const rateCheck = await rateLimiter.consumeRateLimit('YOUTUBE', config.id);
        if (!rateCheck.allowed) {
            logger.warn('YouTube rate limit exceeded', { sourceId: config.id });
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 0, errors: 0 },
            };
        }

        try {
            const apiKey = getApiKey();
            let videoIds: string[] = [];

            // Determine fetch mode: playlist or channel uploads
            if (playlistId) {
                // Fetch from playlist
                if (!(await trackQuota(QUOTA_COSTS.playlistItems))) {
                    throw new Error('YouTube quota exceeded');
                }

                const playlistUrl = new URL(`${YOUTUBE_API_BASE}/playlistItems`);
                playlistUrl.searchParams.set('part', 'snippet');
                playlistUrl.searchParams.set('playlistId', playlistId);
                playlistUrl.searchParams.set('maxResults', maxResults.toString());
                playlistUrl.searchParams.set('key', apiKey);
                if (cursor) playlistUrl.searchParams.set('pageToken', cursor);

                const response = await fetch(playlistUrl.toString());
                if (!response.ok) {
                    throw new Error(`YouTube API error: ${response.status}`);
                }

                const data = await response.json();
                nextCursor = data.nextPageToken;

                videoIds = data.items?.map((item: { snippet: { resourceId: { videoId: string } } }) =>
                    item.snippet.resourceId.videoId
                ) || [];

            } else if (channelId) {
                // Get channel's uploads playlist
                if (!(await trackQuota(QUOTA_COSTS.channels))) {
                    throw new Error('YouTube quota exceeded');
                }

                const channelUrl = new URL(`${YOUTUBE_API_BASE}/channels`);
                channelUrl.searchParams.set('part', 'contentDetails');
                channelUrl.searchParams.set('id', channelId);
                channelUrl.searchParams.set('key', apiKey);

                const channelResponse = await fetch(channelUrl.toString());
                const channelData = await channelResponse.json();

                const uploadsPlaylistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
                if (!uploadsPlaylistId) {
                    throw new Error('Could not find uploads playlist for channel');
                }

                // Now fetch from uploads playlist
                if (!(await trackQuota(QUOTA_COSTS.playlistItems))) {
                    throw new Error('YouTube quota exceeded');
                }

                const playlistUrl = new URL(`${YOUTUBE_API_BASE}/playlistItems`);
                playlistUrl.searchParams.set('part', 'snippet');
                playlistUrl.searchParams.set('playlistId', uploadsPlaylistId);
                playlistUrl.searchParams.set('maxResults', maxResults.toString());
                playlistUrl.searchParams.set('key', apiKey);
                if (cursor) playlistUrl.searchParams.set('pageToken', cursor);

                const response = await fetch(playlistUrl.toString());
                const data = await response.json();
                nextCursor = data.nextPageToken;

                videoIds = data.items?.map((item: { snippet: { resourceId: { videoId: string } } }) =>
                    item.snippet.resourceId.videoId
                ) || [];
            }

            // Fetch video details for duration
            if (videoIds.length > 0) {
                if (!(await trackQuota(QUOTA_COSTS.videos))) {
                    throw new Error('YouTube quota exceeded');
                }

                const videosUrl = new URL(`${YOUTUBE_API_BASE}/videos`);
                videosUrl.searchParams.set('part', 'snippet,contentDetails');
                videosUrl.searchParams.set('id', videoIds.join(','));
                videosUrl.searchParams.set('key', apiKey);

                const videosResponse = await fetch(videosUrl.toString());
                const videosData = await videosResponse.json();

                for (const video of videosData.items || []) {
                    const item: RawFetchedItem = {
                        externalId: video.id,
                        sourceType: 'YOUTUBE',
                        url: `https://www.youtube.com/watch?v=${video.id}`,
                        title: video.snippet.title,
                        content: video.snippet.description || '',
                        excerpt: video.snippet.description?.substring(0, 200) || '',
                        author: video.snippet.channelTitle,
                        publishedAt: video.snippet.publishedAt,
                        thumbnailUrl: getBestThumbnail(video.snippet.thumbnails || {}),
                        duration: parseDuration(video.contentDetails?.duration),
                        metadata: {
                            videoId: video.id,
                            channelId: video.snippet.channelId,
                            channelTitle: video.snippet.channelTitle,
                            playlistId: playlistId,
                            tags: video.snippet.tags,
                            categoryId: video.snippet.categoryId,
                        },
                        fetchedAt: new Date().toISOString(),
                    };

                    items.push(item);
                }
            }

            logger.info('YouTube videos fetched', {
                sourceId: config.id,
                totalItems: items.length,
                hasMore: !!nextCursor,
            });

            return {
                items,
                cursor: nextCursor,
                hasMore: !!nextCursor,
                metadata: {
                    totalFetched: items.length,
                    skipped: 0,
                    errors: 0,
                },
            };
        } catch (error) {
            logger.error('Failed to fetch YouTube videos', error, { sourceId: config.id });
            throw error;
        }
    },
};
