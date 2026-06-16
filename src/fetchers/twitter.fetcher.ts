/**
 * Twitter/X Fetcher
 * Adapter interface supporting API or scraping modes
 * Phase 2: Implements basic scraping mode with rate limiting
 */
import { fetchTwitterProfile } from '../ai/enrichment-client.js';
import { logger } from '../observability/logger.js';
import { rateLimiter } from '../services/rate-limiter.js';
import type { Fetcher, FetchResult, RawFetchedItem, SourceConfig, TwitterSourceConfig } from './types.js';

/** Normalize a handle, @handle, or x.com/twitter.com URL to a bare handle. */
function parseXHandle(raw: string): string {
    let s = (raw || '').trim();
    s = s.replace(/^https?:\/\//i, '').replace(/^(www\.)?(x|twitter|mobile\.twitter)\.com\//i, '');
    s = s.replace(/^@/, '');
    s = s.split(/[/?#]/)[0] ?? '';
    return s.trim();
}

/**
 * Twitter adapter interface - allows switching between API and scrape modes
 */
interface TwitterAdapter {
    mode: 'api' | 'scrape';
    fetch(config: TwitterSourceConfig, cursor?: string): Promise<FetchResult>;
}

/**
 * Syndication scrape adapter (primary) — reads a profile's public timeline via
 * Enrichment's /v1/extract/twitter (no login, no API key). Harnessed: any failure
 * (incl. syndication 429 / missing handle) degrades to an empty, error-tagged
 * result and never throws, so the fetch worker stays up. Honors per-source
 * skipRetweets / skipReplies / minEngagement; cursor = newest tweet id for dedup.
 */
const scrapeAdapter: TwitterAdapter = {
    mode: 'scrape',

    async fetch(config: TwitterSourceConfig, cursor?: string): Promise<FetchResult> {
        const handle = config.settings.username || parseXHandle(config.url);
        if (!handle) {
            logger.warn('Twitter scrape: no handle resolved', { sourceId: config.id, url: config.url });
            return { items: [], hasMore: false, metadata: { totalFetched: 0, skipped: 0, errors: 1, reason: 'No X handle could be resolved from this source.' } };
        }

        const rateCheck = await rateLimiter.consumeRateLimit('TWITTER', config.id);
        if (!rateCheck.allowed) {
            logger.warn('Twitter scrape rate limit exceeded', { sourceId: config.id });
            return { items: [], hasMore: false, metadata: { totalFetched: 0, skipped: 0, errors: 0, reason: 'Local rate limit hit — wait a moment and retry.' } };
        }

        const { minEngagement = 0, skipRetweets = false, skipReplies = false } = config.settings;

        let profile;
        try {
            profile = await fetchTwitterProfile(handle);
        } catch (error) {
            logger.error('Twitter scrape fetch failed', error, { sourceId: config.id, handle });
            return { items: [], hasMore: false, metadata: { totalFetched: 0, skipped: 0, errors: 1, reason: `Enrichment fetch failed: ${(error as Error).message}` } };
        }
        if (!profile.exists) {
            // Distinguish X's IP throttle (429) from a missing/protected account.
            const reason = profile.rate_limited
                ? `X has rate-limited this server's IP (429) on the public timeline endpoint — after heavy use this block can last hours. Fetching keeps retrying automatically; for reliable ingestion enable the official X API (set TWITTER_BEARER_TOKEN) or run from the production deployment.`
                : `@${handle} has no public timeline (account may be protected, suspended, or renamed).`;
            logger.warn('Twitter scrape: profile unavailable', { sourceId: config.id, handle, rateLimited: profile.rate_limited });
            return { items: [], hasMore: false, metadata: { totalFetched: 0, skipped: 0, errors: 1, reason } };
        }

        const items: RawFetchedItem[] = [];
        let skipped = 0;
        // Snowflake ids are numeric — compare as BigInt, not lexically (ids of
        // different digit-lengths sort wrong as strings).
        const idGt = (a: string, b: string) => {
            try { return BigInt(a) > BigInt(b); } catch { return a > b; }
        };
        for (const p of profile.posts) {
            if (cursor && !idGt(p.id, cursor)) { skipped++; continue; }      // already ingested
            if (skipRetweets && p.is_retweet) { skipped++; continue; }
            if (skipReplies && p.is_reply) { skipped++; continue; }
            if ((p.likes + p.retweets) < minEngagement) { skipped++; continue; }

            items.push({
                externalId: p.id,
                sourceType: 'TWITTER',
                url: p.url || `https://x.com/${handle}/status/${p.id}`,
                title: p.text.slice(0, 100),
                content: p.text,
                excerpt: p.text.slice(0, 280),
                author: profile.name || handle,
                publishedAt: p.created_at || undefined,
                engagement: { likes: p.likes, shares: p.retweets, comments: p.replies },
                metadata: {
                    tweetId: p.id,
                    authorUsername: handle,
                    followers: profile.followers,
                    verified: profile.verified,
                    isRetweet: p.is_retweet,
                    isReply: p.is_reply,
                },
                fetchedAt: new Date().toISOString(),
            });
        }

        // newest id → cursor for the next incremental poll (numeric max).
        const newestId = profile.posts.reduce((m, p) => (idGt(p.id, m) ? p.id : m), cursor || '0');

        logger.info('Twitter tweets scraped', { sourceId: config.id, handle, fetched: items.length, skipped });
        const reason = items.length === 0 && profile.posts.length > 0
            ? 'No new tweets since the last fetch (recent posts already ingested or filtered out).'
            : undefined;
        return {
            items,
            cursor: newestId || undefined,
            hasMore: false,
            metadata: { totalFetched: items.length, skipped, errors: 0, reason },
        };
    },
};

/**
 * API adapter - uses official Twitter API
 * NOTE: Requires Twitter API v2 credentials
 */
const apiAdapter: TwitterAdapter = {
    mode: 'api',

    async fetch(config: TwitterSourceConfig, cursor?: string): Promise<FetchResult> {
        const bearerToken = process.env['TWITTER_BEARER_TOKEN'];

        if (!bearerToken) {
            logger.error('Twitter API bearer token not configured');
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 0, errors: 1 },
            };
        }

        const rateCheck = await rateLimiter.consumeRateLimit('TWITTER', config.id);
        if (!rateCheck.allowed) {
            logger.warn('Twitter API rate limit exceeded', { sourceId: config.id });
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 0, errors: 0 },
            };
        }

        try {
            const { searchQuery, userId, minEngagement = 0 } = config.settings;
            const items: RawFetchedItem[] = [];
            let nextCursor: string | undefined;

            // Build API URL
            let url: string;
            const params = new URLSearchParams({
                'tweet.fields': 'created_at,public_metrics,author_id,conversation_id,in_reply_to_user_id',
                'user.fields': 'name,username',
                'max_results': '20',
                'expansions': 'author_id,in_reply_to_user_id',
            });

            if (cursor) params.set('pagination_token', cursor);

            if (searchQuery) {
                url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(searchQuery)}&${params}`;
            } else if (userId) {
                url = `https://api.twitter.com/2/users/${userId}/tweets?${params}`;
            } else {
                throw new Error('Twitter config must have searchQuery or userId');
            }

            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${bearerToken}`,
                },
            });

            if (!response.ok) {
                const body = await response.text();
                throw new Error(`Twitter API error: ${response.status} - ${body}`);
            }

            const data = await response.json();

            // Build user map for author lookup
            const userMap = new Map<string, { name: string; username: string }>();
            for (const user of data.includes?.users || []) {
                userMap.set(user.id, { name: user.name, username: user.username });
            }

            for (const tweet of data.data || []) {
                const metrics = tweet.public_metrics || {};
                const totalEngagement = (metrics.like_count || 0) + (metrics.retweet_count || 0);

                // Engagement filtering
                if (totalEngagement < minEngagement) continue;

                const author = userMap.get(tweet.author_id);
                const isReply = !!tweet.in_reply_to_user_id;

                const item: RawFetchedItem = {
                    externalId: tweet.id,
                    sourceType: 'TWITTER',
                    url: `https://twitter.com/${author?.username || 'user'}/status/${tweet.id}`,
                    title: tweet.text.substring(0, 100),
                    content: tweet.text,
                    excerpt: tweet.text.substring(0, 280),
                    author: author?.name || author?.username,
                    publishedAt: tweet.created_at,
                    engagement: {
                        likes: metrics.like_count,
                        shares: metrics.retweet_count,
                        comments: metrics.reply_count,
                    },
                    metadata: {
                        tweetId: tweet.id,
                        authorId: tweet.author_id,
                        authorUsername: author?.username,
                        conversationId: tweet.conversation_id,
                        isReply,
                        inReplyToUserId: tweet.in_reply_to_user_id,
                        quoteCount: metrics.quote_count,
                    },
                    fetchedAt: new Date().toISOString(),
                };

                items.push(item);
            }

            nextCursor = data.meta?.next_token;

            logger.info('Twitter tweets fetched', {
                sourceId: config.id,
                totalTweets: items.length,
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
            logger.error('Failed to fetch tweets', error, { sourceId: config.id });
            throw error;
        }
    },
};

/**
 * Main Twitter fetcher - routes to appropriate adapter
 */
export const twitterFetcher: Fetcher = {
    sourceType: 'TWITTER',

    async fetch(config: SourceConfig, cursor?: string): Promise<FetchResult> {
        const twitterConfig = config as TwitterSourceConfig;
        // Syndication scrape is primary; the official API is an opt-in add-on.
        const mode = twitterConfig.settings.mode || 'scrape';

        if (mode === 'api') {
            return apiAdapter.fetch(twitterConfig, cursor);
        }

        logger.info('Fetching Twitter content', { sourceId: config.id, mode: 'scrape' });
        const result = await scrapeAdapter.fetch(twitterConfig, cursor);

        // Self-heal: if syndication returned nothing (e.g. X 429-banned this IP) and
        // an official-API token is configured, transparently retry via the API.
        if (result.items.length === 0 && result.metadata.errors > 0 && process.env['TWITTER_BEARER_TOKEN']) {
            logger.warn('Twitter syndication failed — falling back to official API', {
                sourceId: config.id, reason: result.metadata.reason,
            });
            const apiResult = await apiAdapter.fetch(twitterConfig, cursor);
            if (apiResult.items.length > 0 || apiResult.metadata.errors === 0) return apiResult;
        }

        return result;
    },
};
