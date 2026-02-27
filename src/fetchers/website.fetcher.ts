/**
 * Website Fetcher
 * Scrapes content items from arbitrary website pages using configurable selectors.
 */
import * as cheerio from 'cheerio';
import { logger } from '../observability/logger.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { scraperService } from '../services/scraper.service.js';
import type { Fetcher, FetchResult, RawFetchedItem, SourceConfig, WebsiteSourceConfig } from './types.js';

interface WebsiteSelectors {
    item: string;
    link: string;
    title?: string;
    excerpt?: string;
    author?: string;
    date?: string;
}

const DEFAULT_SELECTORS: WebsiteSelectors = {
    item: 'article, .post, .entry, .news-item, li',
    link: 'a[href]',
    title: 'h1, h2, h3, .title, .headline',
    excerpt: 'p, .excerpt, .summary, .description',
    author: '.author, [rel="author"]',
    date: 'time, .date, .published',
};

function buildSelectors(config: WebsiteSourceConfig): WebsiteSelectors {
    const selectors = (config.settings.selectors || {}) as Record<string, unknown>;
    return {
        item: typeof selectors.item === 'string' && selectors.item.trim() ? selectors.item.trim() : DEFAULT_SELECTORS.item,
        link: typeof selectors.link === 'string' && selectors.link.trim() ? selectors.link.trim() : DEFAULT_SELECTORS.link,
        title: typeof selectors.title === 'string' && selectors.title.trim() ? selectors.title.trim() : DEFAULT_SELECTORS.title,
        excerpt: typeof selectors.excerpt === 'string' && selectors.excerpt.trim() ? selectors.excerpt.trim() : DEFAULT_SELECTORS.excerpt,
        author: typeof selectors.author === 'string' && selectors.author.trim() ? selectors.author.trim() : DEFAULT_SELECTORS.author,
        date: typeof selectors.date === 'string' && selectors.date.trim() ? selectors.date.trim() : DEFAULT_SELECTORS.date,
    };
}

function toAbsoluteUrl(baseUrl: string, maybeRelativeUrl: string): string | null {
    try {
        return new URL(maybeRelativeUrl, baseUrl).toString();
    } catch {
        return null;
    }
}

async function fetchWebsiteHtml(url: string, timeoutMs = 15000): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'WahbBot/1.0 (Website Fetcher)',
                Accept: 'text/html,application/xhtml+xml',
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch website (status ${response.status})`);
        }

        return response.text();
    } finally {
        clearTimeout(timeoutId);
    }
}

export const websiteFetcher: Fetcher = {
    sourceType: 'WEBSITE',

    async fetch(config: SourceConfig, _cursor?: string): Promise<FetchResult> {
        const typedConfig = config as WebsiteSourceConfig;
        const sourceUrl = (typedConfig.settings.url as string) || config.url;
        const selectors = buildSelectors(typedConfig);
        const maxItems = Math.min(
            100,
            Math.max(1, Number((typedConfig.settings.maxItems as number) || 30))
        );

        const items: RawFetchedItem[] = [];
        let skipped = 0;
        let errors = 0;

        const rateCheck = await rateLimiter.consumeRateLimit('WEBSITE', config.id);
        if (!rateCheck.allowed) {
            logger.warn('Website rate limit exceeded', { sourceId: config.id, resetMs: rateCheck.resetMs });
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 0, errors: 0 },
            };
        }

        try {
            logger.info('Fetching website source', { sourceId: config.id, url: sourceUrl });
            const html = await fetchWebsiteHtml(sourceUrl);
            const $ = cheerio.load(html);
            const seenUrls = new Set<string>();

            const candidates = $(selectors.item).toArray().slice(0, maxItems * 2);
            for (const element of candidates) {
                if (items.length >= maxItems) {
                    break;
                }

                try {
                    const row = $(element);
                    const linkCandidate = row.find(selectors.link).first().attr('href') || '';
                    if (!linkCandidate.trim()) {
                        skipped++;
                        continue;
                    }

                    const absoluteUrl = toAbsoluteUrl(sourceUrl, linkCandidate);
                    if (!absoluteUrl || seenUrls.has(absoluteUrl)) {
                        skipped++;
                        continue;
                    }
                    seenUrls.add(absoluteUrl);

                    const title =
                        (selectors.title ? row.find(selectors.title).first().text().trim() : '') ||
                        row.find(selectors.link).first().text().trim() ||
                        absoluteUrl;
                    const excerpt = selectors.excerpt ? row.find(selectors.excerpt).first().text().trim() : '';
                    const author = selectors.author ? row.find(selectors.author).first().text().trim() : '';
                    const publishedAt = selectors.date ? row.find(selectors.date).first().attr('datetime') || row.find(selectors.date).first().text().trim() : undefined;

                    // Try allowlisted full-article scrape for better body text when possible.
                    let content = excerpt;
                    const scraped = await scraperService.scrapeArticle(absoluteUrl);
                    if (scraped) {
                        content = scraped.content;
                    }

                    items.push({
                        externalId: absoluteUrl,
                        sourceType: 'WEBSITE',
                        url: absoluteUrl,
                        title: title || 'Untitled',
                        content: content || undefined,
                        excerpt: (excerpt || content || '').substring(0, 500),
                        author: author || undefined,
                        publishedAt: publishedAt || undefined,
                        metadata: {
                            pageUrl: sourceUrl,
                            scraped: !!scraped,
                            selectors,
                            sourceType: 'WEBSITE',
                        },
                        fetchedAt: new Date().toISOString(),
                    });
                } catch (itemError) {
                    errors++;
                    logger.error('Failed to parse website item', itemError, {
                        sourceId: config.id,
                        url: sourceUrl,
                    });
                }
            }

            return {
                items,
                hasMore: false,
                metadata: {
                    totalFetched: items.length,
                    skipped,
                    errors,
                },
            };
        } catch (error) {
            logger.error('Failed to fetch website source', error, {
                sourceId: config.id,
                url: sourceUrl,
            });
            throw error;
        }
    },
};
