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
    // rss-parser surfaces <enclosure> by default but NOT the Media RSS
    // namespace, which is where most news feeds (CNN, etc.) put their images.
    customFields: {
        item: [
            ['media:content', 'mediaContent', { keepArray: true }],
            ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
        ],
    },
});

// Attribute bag rss-parser builds for a Media RSS node, e.g.
// { $: { url, medium, type, width, height } }.
interface MediaNode {
    $?: { url?: string; medium?: string; type?: string };
}

/**
 * Pick a post image from an RSS entry. Priority: Media RSS <media:content>
 * (image) → <media:thumbnail> → an image <enclosure>. Returns undefined when the
 * entry carries no usable image (caller then falls back to the scraped og:image).
 */
function extractRssImage(entry: Record<string, unknown>): string | undefined {
    const isImage = (n?: MediaNode): boolean => {
        const a = n?.$;
        if (!a?.url) return false;
        if (a.medium === 'image') return true;
        if (a.type?.startsWith('image/')) return true;
        // No type hint → accept by extension.
        return /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(a.url);
    };
    const firstUrl = (nodes: unknown): string | undefined => {
        const arr = Array.isArray(nodes) ? (nodes as MediaNode[]) : nodes ? [nodes as MediaNode] : [];
        return arr.find(isImage)?.$?.url;
    };

    const fromContent = firstUrl(entry.mediaContent);
    if (fromContent) return fromContent;
    const fromThumb = firstUrl(entry.mediaThumbnail);
    if (fromThumb) return fromThumb;

    const enc = entry.enclosure as { url?: string; type?: string } | undefined;
    if (enc?.url && (enc.type?.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(enc.url))) {
        return enc.url;
    }
    return undefined;
}

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

                    // Image priority: the feed's own Media RSS / enclosure image,
                    // else the article's og:image from the scrape.
                    const thumbnailUrl =
                        extractRssImage(entry as unknown as Record<string, unknown>) ||
                        scraped?.image ||
                        undefined;

                    const item: RawFetchedItem = {
                        externalId: entry.guid || entry.link,
                        sourceType: 'RSS',
                        url: entry.link,
                        title: entry.title || 'Untitled',
                        content,
                        excerpt: excerpt.substring(0, 500),
                        author: entry.creator || (entry as { author?: string }).author || undefined,
                        thumbnailUrl,
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
