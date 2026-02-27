import { JSDOM } from 'jsdom';
import { logger } from '../observability/logger.js';

export interface DiscoveredFeed {
    url: string;
    title?: string;
    type: 'RSS' | 'ATOM' | 'XML';
}

const COMMON_FEED_PATHS = ['/feed', '/feed.xml', '/rss', '/rss.xml', '/atom.xml'];

function classifyFeedType(typeHint: string): DiscoveredFeed['type'] {
    const normalized = typeHint.toLowerCase();
    if (normalized.includes('atom')) {
        return 'ATOM';
    }
    if (normalized.includes('rss')) {
        return 'RSS';
    }
    return 'XML';
}

function parseFeedTypeFromBody(body: string): DiscoveredFeed['type'] | null {
    const sample = body.slice(0, 2000).toLowerCase();
    if (sample.includes('<rss')) {
        return 'RSS';
    }
    if (sample.includes('<feed')) {
        return 'ATOM';
    }
    return null;
}

async function fetchText(url: string, timeoutMs = 8000): Promise<{ body: string; contentType: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'WahbBot/1.0 (Feed Discovery)',
                Accept: 'text/html,application/rss+xml,application/atom+xml,application/xml,text/xml,*/*',
            },
        });

        if (!response.ok) {
            return { body: '', contentType: '' };
        }

        return {
            body: await response.text(),
            contentType: response.headers.get('content-type') || '',
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function probeCommonFeedPaths(baseUrl: URL): Promise<DiscoveredFeed[]> {
    const discovered: DiscoveredFeed[] = [];

    for (const path of COMMON_FEED_PATHS) {
        try {
            const candidateUrl = new URL(path, baseUrl).toString();
            const { body, contentType } = await fetchText(candidateUrl, 5000);
            if (!body) {
                continue;
            }

            const inferredType = parseFeedTypeFromBody(body) || classifyFeedType(contentType);
            if (parseFeedTypeFromBody(body)) {
                discovered.push({
                    url: candidateUrl,
                    type: inferredType,
                });
            }
        } catch (error) {
            logger.debug('Common feed path probe failed', {
                baseUrl: baseUrl.toString(),
                path,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }

    return discovered;
}

export async function discoverFeeds(targetUrl: string): Promise<DiscoveredFeed[]> {
    const sanitizedUrl = targetUrl.trim();
    if (!sanitizedUrl) {
        return [];
    }

    let normalizedUrl: URL;
    try {
        normalizedUrl = new URL(sanitizedUrl);
    } catch {
        throw new Error('Invalid URL');
    }

    const discovered: DiscoveredFeed[] = [];
    const seen = new Set<string>();

    const addFeed = (feed: DiscoveredFeed) => {
        const normalized = feed.url.trim();
        if (!normalized || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        discovered.push(feed);
    };

    const { body, contentType } = await fetchText(normalizedUrl.toString());
    if (!body) {
        return [];
    }

    const bodyFeedType = parseFeedTypeFromBody(body);
    if (bodyFeedType) {
        addFeed({
            url: normalizedUrl.toString(),
            type: bodyFeedType,
        });
    }

    // If the page is HTML, inspect <link rel="alternate"> tags.
    if (contentType.includes('text/html')) {
        const dom = new JSDOM(body, { url: normalizedUrl.toString() });
        const linkElements = dom.window.document.querySelectorAll('link[rel~="alternate"][href]');

        for (const link of linkElements) {
            const typeAttr = (link.getAttribute('type') || '').toLowerCase();
            if (!typeAttr.includes('rss') && !typeAttr.includes('atom') && !typeAttr.includes('xml')) {
                continue;
            }

            const href = link.getAttribute('href');
            if (!href) {
                continue;
            }

            try {
                const absolute = new URL(href, normalizedUrl).toString();
                addFeed({
                    url: absolute,
                    title: link.getAttribute('title') || undefined,
                    type: classifyFeedType(typeAttr),
                });
            } catch {
                // Skip malformed feed URLs.
            }
        }
    }

    const fallbackFeeds = await probeCommonFeedPaths(normalizedUrl);
    fallbackFeeds.forEach(addFeed);

    return discovered;
}

export const feedDiscoveryService = {
    discoverFeeds,
};
