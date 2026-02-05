/**
 * Reddit API Fetcher
 * Fetches posts/comments from subreddits with OAuth authentication
 */
import { logger } from '../observability/logger.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { getRedisConnection } from '../queues/redis.js';
import type { Fetcher, FetchResult, RawFetchedItem, SourceConfig, RedditSourceConfig } from './types.js';

const REDDIT_API_BASE = 'https://oauth.reddit.com';
const TOKEN_KEY = 'reddit:accesstoken';
const TOKEN_EXPIRY_KEY = 'reddit:tokenexpiry';

interface RedditPost {
    data: {
        id: string;
        name: string;
        title: string;
        selftext?: string;
        author: string;
        permalink: string;
        url: string;
        created_utc: number;
        score: number;
        num_comments: number;
        ups: number;
        subreddit: string;
        subreddit_id: string;
        is_self: boolean;
        thumbnail?: string;
        link_flair_text?: string;
        parent_id?: string;  // For comments
        body?: string;       // For comments
    };
}

interface RedditListing {
    data: {
        after?: string;
        before?: string;
        children: RedditPost[];
    };
}

/**
 * Get OAuth access token for Reddit API
 */
async function getAccessToken(): Promise<string> {
    const redis = getRedisConnection();

    // Check cached token
    const cachedToken = await redis.get(TOKEN_KEY);
    const expiry = await redis.get(TOKEN_EXPIRY_KEY);

    if (cachedToken && expiry && parseInt(expiry) > Date.now()) {
        return cachedToken;
    }

    // Get new token
    const clientId = process.env['REDDIT_CLIENT_ID'];
    const clientSecret = process.env['REDDIT_CLIENT_SECRET'];
    const username = process.env['REDDIT_USERNAME'];
    const password = process.env['REDDIT_PASSWORD'];

    if (!clientId || !clientSecret) {
        throw new Error('Reddit OAuth credentials not configured');
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    let body: string;
    if (username && password) {
        // Script app flow
        body = `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    } else {
        // App-only flow
        body = 'grant_type=client_credentials';
    }

    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'WahbBot/1.0',
        },
        body,
    });

    if (!response.ok) {
        throw new Error(`Reddit auth failed: ${response.status}`);
    }

    const data = await response.json();
    const token = data.access_token;
    const expiresIn = data.expires_in || 3600;

    // Cache token
    await redis.setex(TOKEN_KEY, expiresIn - 60, token);
    await redis.setex(TOKEN_EXPIRY_KEY, expiresIn - 60, (Date.now() + (expiresIn - 60) * 1000).toString());

    return token;
}

/**
 * Fetch parent context for a comment
 */
async function fetchParentContext(
    accessToken: string,
    subreddit: string,
    postId: string
): Promise<{ id: string; title: string; author: string; text?: string } | undefined> {
    try {
        const response = await fetch(`${REDDIT_API_BASE}/r/${subreddit}/comments/${postId}?depth=1&limit=1`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': 'WahbBot/1.0',
            },
        });

        if (!response.ok) return undefined;

        const data = await response.json();
        const post = data[0]?.data?.children?.[0]?.data;

        if (post) {
            return {
                id: post.id,
                title: post.title,
                author: post.author,
                text: post.selftext?.substring(0, 500),
            };
        }
    } catch {
        // Ignore parent fetch errors
    }

    return undefined;
}

export const redditFetcher: Fetcher = {
    sourceType: 'REDDIT',

    async fetch(config: SourceConfig, cursor?: string): Promise<FetchResult> {
        const redditConfig = config as RedditSourceConfig;
        const { subreddit, sortBy = 'hot', minScore = 10, limit = 25 } = redditConfig.settings;

        const items: RawFetchedItem[] = [];
        let skipped = 0;

        // Check rate limit
        const rateCheck = await rateLimiter.consumeRateLimit('REDDIT', config.id);
        if (!rateCheck.allowed) {
            logger.warn('Reddit rate limit exceeded', { sourceId: config.id });
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 0, errors: 0 },
            };
        }

        try {
            const accessToken = await getAccessToken();

            const url = new URL(`${REDDIT_API_BASE}/r/${subreddit}/${sortBy}`);
            url.searchParams.set('limit', limit.toString());
            if (cursor) url.searchParams.set('after', cursor);

            logger.info('Fetching Reddit posts', { subreddit, sortBy, sourceId: config.id });

            const response = await fetch(url.toString(), {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'User-Agent': 'WahbBot/1.0',
                },
            });

            if (!response.ok) {
                throw new Error(`Reddit API error: ${response.status}`);
            }

            const listing: RedditListing = await response.json();

            for (const post of listing.data.children) {
                const postData = post.data;

                // Engagement filtering
                if (postData.score < minScore) {
                    skipped++;
                    continue;
                }

                const item: RawFetchedItem = {
                    externalId: postData.id,
                    sourceType: 'REDDIT',
                    url: `https://reddit.com${postData.permalink}`,
                    title: postData.title,
                    content: postData.selftext || postData.title,
                    excerpt: (postData.selftext || postData.title).substring(0, 300),
                    author: postData.author,
                    publishedAt: new Date(postData.created_utc * 1000).toISOString(),
                    thumbnailUrl: postData.thumbnail?.startsWith('http') ? postData.thumbnail : undefined,
                    engagement: {
                        score: postData.score,
                        likes: postData.ups,
                        comments: postData.num_comments,
                    },
                    metadata: {
                        subreddit: postData.subreddit,
                        subredditId: postData.subreddit_id,
                        isSelfPost: postData.is_self,
                        externalUrl: postData.is_self ? undefined : postData.url,
                        flairText: postData.link_flair_text,
                        redditName: postData.name,
                    },
                    fetchedAt: new Date().toISOString(),
                };

                items.push(item);
            }

            logger.info('Reddit posts fetched', {
                sourceId: config.id,
                subreddit,
                totalPosts: items.length,
                skipped,
                hasMore: !!listing.data.after,
            });

            return {
                items,
                cursor: listing.data.after,
                hasMore: !!listing.data.after,
                metadata: {
                    totalFetched: items.length,
                    skipped,
                    errors: 0,
                },
            };
        } catch (error) {
            logger.error('Failed to fetch Reddit posts', error, { sourceId: config.id });
            throw error;
        }
    },
};
