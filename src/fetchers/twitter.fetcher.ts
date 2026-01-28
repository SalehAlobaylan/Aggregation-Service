/**
 * Twitter/X Fetcher
 * Adapter interface supporting API or scraping modes
 * Phase 2: Implements basic scraping mode with rate limiting
 */
import { logger } from '../observability/logger.js';
import { rateLimiter } from '../services/rate-limiter.js';
import type { Fetcher, FetchResult, RawFetchedItem, SourceConfig, TwitterSourceConfig } from './types.js';

/**
 * Twitter adapter interface - allows switching between API and scrape modes
 */
interface TwitterAdapter {
    mode: 'api' | 'scrape';
    fetch(config: TwitterSourceConfig, cursor?: string): Promise<FetchResult>;
}

/**
 * Scraping adapter - uses web scraping with strict rate limits
 * NOTE: Actual Puppeteer implementation should be added for production
 * This is a placeholder that demonstrates the interface
 */
const scrapeAdapter: TwitterAdapter = {
    mode: 'scrape',

    async fetch(config: TwitterSourceConfig, _cursor?: string): Promise<FetchResult> {
        // Check strict rate limit for scraping (100/hour)
        const rateCheck = await rateLimiter.consumeRateLimit('TWITTER', config.id);
        if (!rateCheck.allowed) {
            logger.warn('Twitter scrape rate limit exceeded', {
                sourceId: config.id,
                resetMs: rateCheck.resetMs
            });
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 0, errors: 0 },
            };
        }

        // TODO: Implement actual Puppeteer-based scraping
        // For Phase 2, this is a placeholder that logs the intent
        logger.warn('Twitter scraping mode not fully implemented', {
            sourceId: config.id,
            searchQuery: config.settings.searchQuery,
            userId: config.settings.userId,
        });

        // Return empty result - actual implementation would scrape tweets
        return {
            items: [],
            hasMore: false,
            metadata: { totalFetched: 0, skipped: 0, errors: 0 },
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
        const mode = twitterConfig.settings.mode || 'scrape';

        const adapter = mode === 'api' ? apiAdapter : scrapeAdapter;

        logger.info('Fetching Twitter content', {
            sourceId: config.id,
            mode: adapter.mode
        });

        return adapter.fetch(twitterConfig, cursor);
    },
};
