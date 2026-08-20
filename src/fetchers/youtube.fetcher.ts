/**
 * YouTube Data API v3 Fetcher
 * Fetches video metadata from channels and playlists
 */
import { logger } from '../observability/logger.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { getRedisConnection } from '../queues/redis.js';
import type { Fetcher, FetchResult, RawFetchedItem, SourceConfig, YouTubeSourceConfig } from './types.js';
import { configuredMaximumDurationSec, configuredMinimumDurationSec, configuredResultLimit } from '../services/pods-admission.js';

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
    await requireYoutubeOk(response, 'handle resolution');

    const data = await response.json();
    return data.items?.[0]?.id || null;
}

async function resolveCustomUrlToChannelId(customUrl: string, apiKey: string): Promise<string | null> {
    const url = new URL(`${YOUTUBE_API_BASE}/channels`);
    url.searchParams.set('part', 'id');
    url.searchParams.set('forCustomUrl', customUrl);
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    await requireYoutubeOk(response, 'custom URL resolution');

    const data = await response.json();
    return data.items?.[0]?.id || null;
}

async function resolveUrlToChannelId(urlStr: string, apiKey: string): Promise<{ channelId?: string; playlistId?: string; searchQuery?: string; isShorts?: boolean } | null> {
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
        
        const playlistIdParam = url.searchParams.get('list') || undefined;
        if (path.includes('/playlist') || path.includes('/watch')) {
            if (playlistIdParam) {
                return { playlistId: playlistIdParam };
            }
        }

        if (path.includes('/hashtag/')) {
            const rawTag = path.split('/hashtag/')[1] || '';
            const tag = decodeURIComponent(rawTag).split('/')[0]?.trim();
            if (tag) {
                return { searchQuery: `#${tag.replace(/^#/, '')}` };
            }
        }

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

export interface ResolvedYoutubeChannel {
    channelId: string;
    title: string;
    thumbnail?: string;
    subscriberCount?: number;
}

/**
 * Resolve a YouTube channel URL / @handle to channel metadata, for the admin
 * "Add media source" flow (show the resolved channel + avatar before saving).
 * Returns null when the URL can't be resolved to a channel.
 */
export async function resolveYoutubeChannel(urlStr: string): Promise<ResolvedYoutubeChannel | null> {
    const apiKey = getApiKey();
    const resolved = await resolveUrlToChannelId(urlStr, apiKey);
    const channelId = resolved?.channelId;
    if (!channelId) return null;

    const url = new URL(`${YOUTUBE_API_BASE}/channels`);
    url.searchParams.set('part', 'snippet,statistics');
    url.searchParams.set('id', channelId);
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
        logger.warn('Failed to fetch YouTube channel metadata', { channelId, status: response.status });
        return null;
    }

    const data = await response.json();
    const item = data.items?.[0];
    if (!item) return null;

    const subsRaw = item.statistics?.subscriberCount;
    const subs = subsRaw != null ? Number(subsRaw) : undefined;
    return {
        channelId,
        title: item.snippet?.title ?? '',
        thumbnail: getBestThumbnail(item.snippet?.thumbnails ?? {}),
        subscriberCount: Number.isFinite(subs) ? subs : undefined,
    };
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

async function requireYoutubeOk(response: Response, operation: string): Promise<void> {
    if (response.ok) return;
    let details = '';
    try {
        const body = await response.json() as { error?: { message?: string } };
        details = body.error?.message ? `: ${body.error.message}` : '';
    } catch {
        // Keep the HTTP status as the stable diagnostic for non-JSON bodies.
    }
    throw new Error(`YouTube ${operation} API error: ${response.status}${details}`);
}

export function shouldContinueYoutubePagination(nextCursor: string | undefined, acceptedCount: number, maxResults: number, currentCursor?: string): boolean {
    // Do not stop on an all-Shorts page: stop only after satisfying this
    // page's accepted-item target or exhausting the provider cursor.
    return Boolean(nextCursor && nextCursor !== currentCursor && acceptedCount < maxResults);
}

export function youtubeCandidateLimit(
    maxResults: number,
    minDurationSec?: number,
    maxDurationSec?: number,
): number {
    // Duration filtering happens after the details lookup. Pull a bounded
    // candidate window so a few Shorts do not empty an otherwise valid batch.
    return minDurationSec || maxDurationSec
        ? Math.min(50, maxResults * 4)
        : maxResults;
}

export const youtubeFetcher: Fetcher = {
    sourceType: 'YOUTUBE',

    async fetch(config: SourceConfig, cursor?: string): Promise<FetchResult> {
        const ytConfig = config as YouTubeSourceConfig;
        const rawSettings = (ytConfig.settings || {}) as Record<string, unknown>;

        const maxResults = configuredResultLimit(rawSettings, 10, 50);

        const maxAgeHoursCandidate = getNumber(rawSettings, ['maxAgeHours', 'max_age_hours']);
        const maxAgeHours = typeof maxAgeHoursCandidate === 'number' && maxAgeHoursCandidate > 0
            ? Math.floor(maxAgeHoursCandidate)
            : undefined;

        const minDurationSec = configuredMinimumDurationSec(rawSettings);

        const maxDurationSec = configuredMaximumDurationSec(rawSettings);
        if (maxDurationSec !== undefined && maxDurationSec < minDurationSec) {
            throw new Error('YouTube duration settings are contradictory: maximum is below minimum');
        }
        const candidateLimit = youtubeCandidateLimit(maxResults, minDurationSec, maxDurationSec);

        let { channelId, playlistId, searchQuery } = ytConfig.settings as {
            channelId?: string;
            playlistId?: string;
            searchQuery?: string;
        };

        const items: RawFetchedItem[] = [];
        let nextCursor: string | undefined;

        const rateCheck = await rateLimiter.consumeRateLimit('YOUTUBE', config.id);
        if (!rateCheck.allowed) {
            logger.warn('YouTube rate limit exceeded', { sourceId: config.id });
            throw new Error('YouTube source rate limit exceeded');
        }

        try {
            const apiKey = getApiKey();

            if (!channelId && !playlistId && !searchQuery && config.url) {
                logger.info('Resolving YouTube URL to channel/playlist', { url: config.url });
                const resolved = await resolveUrlToChannelId(config.url, apiKey);
                if (resolved) {
                    channelId = resolved.channelId;
                    playlistId = resolved.playlistId;
                    searchQuery = resolved.searchQuery;
                    if (resolved.isShorts && channelId) {
                        // Shorts cannot satisfy the canonical 270-second Pods
                        // floor. Treat the URL as a channel selector and fetch
                        // eligible uploads instead of spending quota on a
                        // surface whose entire inventory will be rejected.
                        logger.info('URL targets Shorts; using channel uploads for Pods eligibility', { channelId });
                    }
                    if (channelId) {
                        logger.info('Resolved channel ID', { channelId });
                    }
                    if (playlistId) {
                        logger.info('Resolved playlist ID', { playlistId });
                    }
                    if (searchQuery) {
                        logger.info('Resolved search query', { searchQuery });
                    }
                } else {
                    logger.warn('Could not resolve channel or playlist from URL', { url: config.url });
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
            let missingVideoDetails = 0;

            // Determine fetch mode: playlist, search, or channel uploads
            if (playlistId) {
                // Fetch from playlist
                if (!(await trackQuota(QUOTA_COSTS.playlistItems))) {
                    throw new Error('YouTube quota exceeded');
                }

                const playlistUrl = new URL(`${YOUTUBE_API_BASE}/playlistItems`);
                playlistUrl.searchParams.set('part', 'snippet');
                playlistUrl.searchParams.set('playlistId', playlistId);
                playlistUrl.searchParams.set('maxResults', candidateLimit.toString());
                playlistUrl.searchParams.set('key', apiKey);
                if (cursor) playlistUrl.searchParams.set('pageToken', cursor);

                const response = await fetch(playlistUrl.toString());
                await requireYoutubeOk(response, 'playlistItems');

                const data = await response.json();
                nextCursor = data.nextPageToken;

                videoIds = data.items?.map((item: { snippet: { resourceId: { videoId: string } } }) =>
                    item.snippet.resourceId.videoId
                ) || [];

            } else if (searchQuery) {
                if (!(await trackQuota(QUOTA_COSTS.search))) {
                    throw new Error('YouTube quota exceeded');
                }

                const searchUrl = new URL(`${YOUTUBE_API_BASE}/search`);
                searchUrl.searchParams.set('part', 'snippet');
                searchUrl.searchParams.set('type', 'video');
                searchUrl.searchParams.set('order', 'date');
                searchUrl.searchParams.set('q', searchQuery);
                searchUrl.searchParams.set('maxResults', candidateLimit.toString());
                searchUrl.searchParams.set('key', apiKey);
                if (cursor) searchUrl.searchParams.set('pageToken', cursor);

                const searchResponse = await fetch(searchUrl.toString());
                await requireYoutubeOk(searchResponse, 'search');

                const searchData = await searchResponse.json();
                nextCursor = searchData.nextPageToken;
                videoIds = (searchData.items || [])
                    .map((item: { id?: { videoId?: string } }) => item.id?.videoId)
                    .filter((id: string | undefined): id is string => !!id);
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
                await requireYoutubeOk(channelResponse, 'channels');
                const channelData = await channelResponse.json();

                const relatedPlaylists = channelData.items?.[0]?.contentDetails?.relatedPlaylists;
                let targetPlaylistId: string;

                if (fetchShorts) {
                    targetPlaylistId = relatedPlaylists?.shorts;
                    if (!targetPlaylistId) {
                        logger.warn('Channel has no shorts playlist, falling back to search API', { channelId });

                        if (!(await trackQuota(QUOTA_COSTS.search))) {
                            throw new Error('YouTube quota exceeded');
                        }

                        const searchUrl = new URL(`${YOUTUBE_API_BASE}/search`);
                        searchUrl.searchParams.set('part', 'snippet');
                        searchUrl.searchParams.set('channelId', channelId);
                        searchUrl.searchParams.set('type', 'video');
                        searchUrl.searchParams.set('order', 'date');
                        searchUrl.searchParams.set('videoDuration', 'short');
                        searchUrl.searchParams.set('maxResults', candidateLimit.toString());
                        searchUrl.searchParams.set('key', apiKey);
                        if (cursor) searchUrl.searchParams.set('pageToken', cursor);

                        const searchResponse = await fetch(searchUrl.toString());
                        await requireYoutubeOk(searchResponse, 'shorts search');

                        const searchData = await searchResponse.json();
                        nextCursor = searchData.nextPageToken;
                        videoIds = (searchData.items || [])
                            .map((item: { id?: { videoId?: string } }) => item.id?.videoId)
                            .filter((id: string | undefined): id is string => !!id);
                    } else {
                        logger.info('Fetching from shorts playlist', { channelId, playlistId: targetPlaylistId });

                        // Now fetch from selected playlist
                        if (!(await trackQuota(QUOTA_COSTS.playlistItems))) {
                            throw new Error('YouTube quota exceeded');
                        }

                        const playlistUrl = new URL(`${YOUTUBE_API_BASE}/playlistItems`);
                        playlistUrl.searchParams.set('part', 'snippet');
                        playlistUrl.searchParams.set('playlistId', targetPlaylistId);
                        playlistUrl.searchParams.set('maxResults', candidateLimit.toString());
                        playlistUrl.searchParams.set('key', apiKey);
                        if (cursor) playlistUrl.searchParams.set('pageToken', cursor);

                        const response = await fetch(playlistUrl.toString());
                        await requireYoutubeOk(response, 'shorts playlistItems');
                        const data = await response.json();
                        nextCursor = data.nextPageToken;

                        videoIds = data.items?.map((item: { snippet: { resourceId: { videoId: string } } }) =>
                            item.snippet.resourceId.videoId
                        ) || [];
                    }
                } else {
                    targetPlaylistId = relatedPlaylists?.uploads;
                    if (!targetPlaylistId) {
                        throw new Error('Could not find uploads playlist for channel');
                    }

                    // Now fetch from selected playlist
                    if (!(await trackQuota(QUOTA_COSTS.playlistItems))) {
                        throw new Error('YouTube quota exceeded');
                    }

                    const playlistUrl = new URL(`${YOUTUBE_API_BASE}/playlistItems`);
                    playlistUrl.searchParams.set('part', 'snippet');
                    playlistUrl.searchParams.set('playlistId', targetPlaylistId);
                    playlistUrl.searchParams.set('maxResults', candidateLimit.toString());
                    playlistUrl.searchParams.set('key', apiKey);
                    if (cursor) playlistUrl.searchParams.set('pageToken', cursor);

                    const response = await fetch(playlistUrl.toString());
                    await requireYoutubeOk(response, 'uploads playlistItems');
                    const data = await response.json();
                    nextCursor = data.nextPageToken;

                    videoIds = data.items?.map((item: { snippet: { resourceId: { videoId: string } } }) =>
                        item.snippet.resourceId.videoId
                    ) || [];
                }
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
                await requireYoutubeOk(videosResponse, 'videos');
                const videosData = await videosResponse.json();
                missingVideoDetails = Math.max(0, videoIds.length - (videosData.items?.length ?? 0));

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
            let skipped = missingVideoDetails;
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
                skipped += durationSkipped;
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

            const shouldContinue = shouldContinueYoutubePagination(nextCursor, filteredItems.length, maxResults, cursor);

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
