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

const QUOTA_COSTS = {
    search: 100,
    playlistItems: 1,
    videos: 1,
    channels: 1,
};

function getApiKey(): string {
    const key = process.env['YOUTUBE_API_KEY'];
    if (!key) {
        throw new Error('YOUTUBE_API_KEY environment variable is required');
    }
    return key;
}

async function resolveHandleToChannelId(handle: string, apiKey: string): Promise<string | null> {
    const url = new URL(`${YOUTUBE_API_BASE}/channels`);
    url.searchParams.set('part', 'id');
    url.searchParams.set('forHandle', handle.startsWith('@') ? handle : `@${handle}`);
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
        logger.warn('Failed to resolve YouTube handle', { handle, status: response.status });
        return null;
    }

    const data = await response.json();
    return data.items?.[0]?.id || null;
}

async function resolveCustomUrlToChannelId(customUrl: string, apiKey: string): Promise<string | null> {
    const url = new URL(`${YOUTUBE_API_BASE}/channels`);
    url.searchParams.set('part', 'id');
    url.searchParams.set('forCustomUrl', customUrl);
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
        logger.warn('Failed to resolve custom URL', { customUrl, status: response.status });
        return null;
    }

    const data = await response.json();
    return data.items?.[0]?.id || null;
}

async function resolveUrlToChannelId(urlStr: string, apiKey: string): Promise<{ channelId: string; isShorts?: boolean } | null> {
    try {
        const url = new URL(urlStr);
        const path = url.pathname;
        
        const isShorts = path.includes('/shorts');
        const isVideos = path.includes('/videos');
        
        const cleanPath = path
            .replace(/\/shorts$/, '')
            .replace(/\/videos$/, '')
            .replace(/\/featured$/, '')
            .replace(/\/playlists$/, '')
            .replace(/\/community$/, '')
            .replace(/\/channels$/, '')
            .replace(/\/about$/, '')
            .replace(/\/search$/, '')
            .replace(/\/live$/, '')
            .replace(/\/join$/, '')
            .replace(/\/members$/, '');
        
        const username = cleanPath.replace('/@', '').replace('/channel/', '').replace('/c/', '').replace('/user/', '').replace('/', '');

        if (cleanPath.includes('/@')) {
            const channelId = await resolveHandleToChannelId(username, apiKey);
            return channelId ? { channelId, isShorts } : null;
        } else if (cleanPath.includes('/channel/')) {
            const channelId = cleanPath.split('/channel/')[1]?.split('/')[0] || null;
            return channelId ? { channelId, isShorts } : null;
        } else if (cleanPath.includes('/c/') || cleanPath.includes('/user/')) {
            const channelId = await resolveCustomUrlToChannelId(urlStr, apiKey);
            return channelId ? { channelId, isShorts } : null;
        }

        return null;
    } catch {
        return null;
    }
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

function getNumber(raw: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === 'number') {
            return value;
        }
    }
    return undefined;
}

export const youtubeFetcher: Fetcher = {
    sourceType: 'YOUTUBE',

    async fetch(config: SourceConfig, cursor?: string): Promise<FetchResult> {
        const ytConfig = config as YouTubeSourceConfig;
        const rawSettings = (ytConfig.settings || {}) as Record<string, unknown>;

        const maxResultsCandidate = getNumber(rawSettings, ['maxResults', 'max_results']);
        const maxResults = typeof maxResultsCandidate === 'number' && maxResultsCandidate > 0
            ? Math.min(50, Math.floor(maxResultsCandidate))
            : 10;

        const maxAgeHoursCandidate = getNumber(rawSettings, ['maxAgeHours', 'max_age_hours']);
        const maxAgeHours = typeof maxAgeHoursCandidate === 'number' && maxAgeHoursCandidate > 0
            ? Math.floor(maxAgeHoursCandidate)
            : undefined;

        const minDurationMinCandidate = getNumber(rawSettings, ['minDurationMinutes', 'min_duration_minutes']);
        const minDurationSec = typeof minDurationMinCandidate === 'number' && minDurationMinCandidate > 0
            ? Math.floor(minDurationMinCandidate * 60)
            : undefined;

        const maxDurationMinCandidate = getNumber(rawSettings, ['maxDurationMinutes', 'max_duration_minutes']);
        const maxDurationSec = typeof maxDurationMinCandidate === 'number' && maxDurationMinCandidate > 0
            ? Math.floor(maxDurationMinCandidate * 60)
            : undefined;

        let { channelId, playlistId } = ytConfig.settings as {
            channelId?: string;
            playlistId?: string;
        };

        const items: RawFetchedItem[] = [];
        let nextCursor: string | undefined;

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

            if (!channelId && !playlistId && config.url) {
                logger.info('Resolving YouTube URL to channel ID', { url: config.url });
                const resolved = await resolveUrlToChannelId(config.url, apiKey);
                if (resolved) {
                    channelId = resolved.channelId;
                    if (resolved.isShorts) {
                        playlistId = 'shorts'; // Marker to fetch shorts playlist later
                        logger.info('URL targets shorts, will fetch from shorts playlist', { channelId });
                    }
                    logger.info('Resolved channel ID', { channelId });
                } else {
                    logger.warn('Could not resolve channel ID from URL', { url: config.url });
                    return {
                        items: [],
                        hasMore: false,
                        metadata: { totalFetched: 0, skipped: 0, errors: 0 },
                    };
                }
            }

            // Check if we need to fetch shorts playlist
            const fetchShorts = playlistId === 'shorts';
            if (fetchShorts) {
                playlistId = undefined; // Reset so we use channelId path
            }

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
                // Get channel's uploads or shorts playlist
                if (!(await trackQuota(QUOTA_COSTS.channels))) {
                    throw new Error('YouTube quota exceeded');
                }

                const channelUrl = new URL(`${YOUTUBE_API_BASE}/channels`);
                channelUrl.searchParams.set('part', 'contentDetails');
                channelUrl.searchParams.set('id', channelId);
                channelUrl.searchParams.set('key', apiKey);

                const channelResponse = await fetch(channelUrl.toString());
                const channelData = await channelResponse.json();

                const relatedPlaylists = channelData.items?.[0]?.contentDetails?.relatedPlaylists;
                let targetPlaylistId: string;

                if (fetchShorts) {
                    targetPlaylistId = relatedPlaylists?.shorts;
                    if (!targetPlaylistId) {
                        logger.warn('Channel has no shorts playlist', { channelId });
                        return {
                            items: [],
                            hasMore: false,
                            metadata: { totalFetched: 0, skipped: 0, errors: 0 },
                        };
                    }
                    logger.info('Fetching from shorts playlist', { channelId, playlistId: targetPlaylistId });
                } else {
                    targetPlaylistId = relatedPlaylists?.uploads;
                    if (!targetPlaylistId) {
                        throw new Error('Could not find uploads playlist for channel');
                    }
                }

                // Now fetch from selected playlist
                if (!(await trackQuota(QUOTA_COSTS.playlistItems))) {
                    throw new Error('YouTube quota exceeded');
                }

                const playlistUrl = new URL(`${YOUTUBE_API_BASE}/playlistItems`);
                playlistUrl.searchParams.set('part', 'snippet');
                playlistUrl.searchParams.set('playlistId', targetPlaylistId);
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

            // Apply maxAgeHours filter
            let filteredItems = items;
            let skipped = 0;
            if (maxAgeHours && maxAgeHours > 0) {
                const cutoffTime = new Date();
                cutoffTime.setHours(cutoffTime.getHours() - maxAgeHours);
                
                filteredItems = items.filter(item => {
                    if (item.publishedAt) {
                        const publishedDate = new Date(item.publishedAt);
                        if (publishedDate >= cutoffTime) {
                            return true;
                        }
                    }
                    skipped++;
                    return false;
                });
                
                if (skipped > 0) {
                    logger.info('Filtered out old videos', { maxAgeHours, skipped, remaining: filteredItems.length });
                }
            }

            // Apply duration filter (min/max minutes)
            if (minDurationSec || maxDurationSec) {
                const beforeCount = filteredItems.length;
                filteredItems = filteredItems.filter(item => {
                    const dur = item.duration;
                    if (dur === undefined || dur === null) return true; // keep items without duration info
                    if (minDurationSec && dur < minDurationSec) return false;
                    if (maxDurationSec && dur > maxDurationSec) return false;
                    return true;
                });
                const durationSkipped = beforeCount - filteredItems.length;
                if (durationSkipped > 0) {
                    logger.info('Filtered videos by duration', {
                        minDurationSec,
                        maxDurationSec,
                        skipped: durationSkipped,
                        remaining: filteredItems.length,
                    });
                }
            }

            // Apply maxResults limit
            if (maxResults && maxResults > 0 && filteredItems.length > maxResults) {
                filteredItems = filteredItems.slice(0, maxResults);
            }

            // Only continue pagination if we actually got items and haven't reached our limit
            const shouldContinue = !!(nextCursor && filteredItems.length > 0);

            logger.info('YouTube videos fetched', {
                sourceId: config.id,
                totalItems: filteredItems.length,
                skippedItems: skipped,
                hasMore: shouldContinue,
            });

            return {
                items: filteredItems,
                cursor: nextCursor,
                hasMore: shouldContinue,
                metadata: {
                    totalFetched: filteredItems.length,
                    skipped: skipped,
                    errors: 0,
                },
            };
        } catch (error) {
            logger.error('Failed to fetch YouTube videos', error, { sourceId: config.id });
            throw error;
        }
    },
};
