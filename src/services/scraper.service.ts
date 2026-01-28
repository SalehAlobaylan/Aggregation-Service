/**
 * Article scraper using Readability
 * Extracts full article content from HTML pages
 */
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { logger } from '../observability/logger.js';
import { loadAllowlist, isDomainAllowed } from '../config/allowlist.js';

export interface ScrapedArticle {
    title: string;
    content: string;        // Clean text content
    excerpt: string;        // First ~200 chars
    byline?: string;        // Author if detected
    siteName?: string;
    length: number;         // Content length in chars
}

/**
 * Scrape full article content from a URL
 * Only scrapes if domain is allowlisted
 */
export async function scrapeArticle(
    url: string,
    options: {
        timeout?: number;
        forceAllowlist?: boolean;
    } = {}
): Promise<ScrapedArticle | null> {
    const { timeout = 10000, forceAllowlist = true } = options;

    // Check allowlist
    if (forceAllowlist) {
        const allowed = await isDomainAllowed(url);
        if (!allowed) {
            logger.debug('Domain not allowlisted, skipping scrape', { url });
            return null;
        }
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'TurfaBot/1.0 (Content Aggregation Service)',
                'Accept': 'text/html,application/xhtml+xml',
            },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            logger.warn('Failed to fetch article', { url, status: response.status });
            return null;
        }

        const html = await response.text();
        return parseArticleHtml(html, url);
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            logger.warn('Article fetch timeout', { url });
        } else {
            logger.error('Article scrape error', error, { url });
        }
        return null;
    }
}

/**
 * Parse article content from HTML
 */
export function parseArticleHtml(html: string, url: string): ScrapedArticle | null {
    try {
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.textContent) {
            logger.debug('Readability could not parse article', { url });
            return null;
        }

        // Clean up the text content
        const content = cleanText(article.textContent);
        const excerpt = content.substring(0, 200).trim() + (content.length > 200 ? '...' : '');

        return {
            title: article.title || '',
            content,
            excerpt,
            byline: article.byline || undefined,
            siteName: article.siteName || undefined,
            length: content.length,
        };
    } catch (error) {
        logger.error('HTML parsing error', error, { url });
        return null;
    }
}

/**
 * Clean text content: normalize whitespace, remove excess newlines
 */
function cleanText(text: string): string {
    return text
        .replace(/\s+/g, ' ')           // Collapse whitespace
        .replace(/\n\s*\n/g, '\n\n')    // Normalize paragraph breaks
        .trim();
}

export const scraperService = {
    scrapeArticle,
    parseArticleHtml,
};
