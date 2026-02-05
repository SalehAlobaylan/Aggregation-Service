/**
 * RSS Feed Fetcher
 * Parses RSS/Atom feeds and optionally scrapes full articles
 */
import Parser from 'rss-parser';
import { logger } from '../observability/logger.js';
import { scraperService } from '../services/scraper.service.js';
import { rateLimiter } from '../services/rate-limiter.js';
import type { Fetcher, FetchResult, RawFetchedItem, SourceConfig } from './types.js';

const parser = new Parser({
    timeout: 15000,
    headers: {
        'User-Agent': 'WahbBot/1.0 (Content Aggregation Service)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    },
});

export const rssFetcher: Fetcher = {
    sourceType: 'RSS',

    async fetch(config: SourceConfig, _cursor?: string): Promise<FetchResult> {
        const items: RawFetchedItem[] = [];
        let skipped = 0;
        let errors = 0;

        // Check rate limit
        const rateCheck = await rateLimiter.consumeRateLimit('RSS', config.id);
        if (!rateCheck.allowed) {
            logger.warn('RSS rate limit exceeded', { sourceId: config.id, resetMs: rateCheck.resetMs });
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 0, errors: 0 },
            };
        }

        try {
            logger.info('Fetching RSS feed', { url: config.url, sourceId: config.id });
            const feed = await parser.parseURL(config.url);

            for (const entry of feed.items || []) {
                try {
                    // Skip items without link
                    if (!entry.link) {
                        skipped++;
                        continue;
                    }

                    // Get excerpt from content or contentSnippet
                    let excerpt = entry.contentSnippet || entry.content || '';
                    let content = entry.content || '';

                    // Attempt full article scrape for allowlisted domains
                    const scraped = await scraperService.scrapeArticle(entry.link);
                    if (scraped) {
                        content = scraped.content;
                        excerpt = scraped.excerpt;
                    }

                    const item: RawFetchedItem = {
                        externalId: entry.guid || entry.link,
                        sourceType: 'RSS',
                        url: entry.link,
                        title: entry.title || 'Untitled',
                        content,
                        excerpt: excerpt.substring(0, 500),
                        author: entry.creator || entry.author || undefined,
                        publishedAt: entry.isoDate || entry.pubDate || undefined,
                        metadata: {
                            feedTitle: feed.title,
                            feedUrl: config.url,
                            guid: entry.guid,
                            categories: entry.categories,
                            domain: new URL(entry.link).hostname,
                            scraped: !!scraped,
                        },
                        fetchedAt: new Date().toISOString(),
                    };

                    items.push(item);
                } catch (itemError) {
                    errors++;
                    logger.error('Error processing RSS item', itemError, {
                        link: entry.link,
                        sourceId: config.id
                    });
                }
            }

            logger.info('RSS feed fetched', {
                sourceId: config.id,
                totalItems: items.length,
                skipped,
                errors,
            });

            return {
                items,
                hasMore: false, // RSS doesn't have pagination
                metadata: {
                    totalFetched: items.length,
                    skipped,
                    errors,
                },
            };
        } catch (error) {
            logger.error('Failed to fetch RSS feed', error, {
                url: config.url,
                sourceId: config.id
            });
            throw error;
        }
    },
};
