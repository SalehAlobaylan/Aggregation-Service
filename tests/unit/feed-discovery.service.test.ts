import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    safeFetch: vi.fn(),
    globalFetch: vi.fn(),
}));

vi.mock('../../src/utils/safe-fetch.js', () => ({
    SSRFError: class SSRFError extends Error { },
    RateLimitedError: class RateLimitedError extends Error { },
    safeFetch: mocks.safeFetch,
}));

vi.mock('../../src/observability/logger.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.stubGlobal('fetch', mocks.globalFetch);

import { discoverFeeds } from '../../src/services/feed-discovery.service.js';

function safeFetchResult(body: string, contentType: string, ok = true) {
    return {
        ok,
        status: ok ? 200 : 404,
        url: 'https://example.com',
        body,
        contentType,
    };
}

describe('feed discovery service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.safeFetch.mockResolvedValue(safeFetchResult('', '', false));
    });

    it('uses safeFetch for the main URL and common feed paths instead of global fetch', async () => {
        mocks.safeFetch.mockImplementation(async (url: string) => {
            if (url === 'https://example.com/') {
                return safeFetchResult('<html><head></head><body>No feeds here</body></html>', 'text/html');
            }
            return safeFetchResult('', '', false);
        });

        await discoverFeeds('https://example.com');

        expect(mocks.globalFetch).not.toHaveBeenCalled();
        expect(mocks.safeFetch).toHaveBeenCalledTimes(6);
        expect(mocks.safeFetch).toHaveBeenCalledWith('https://example.com/', {
            timeoutMs: 8000,
            rateLimit: false,
        });
        expect(mocks.safeFetch).toHaveBeenCalledWith('https://example.com/feed', {
            timeoutMs: 5000,
            rateLimit: false,
        });
    });

    it('rejects a blocked main URL instead of returning an empty feed list', async () => {
        const { SSRFError } = await import('../../src/utils/safe-fetch.js');
        mocks.safeFetch.mockRejectedValue(new SSRFError('blocked address: 127.0.0.1'));

        await expect(discoverFeeds('http://127.0.0.1/')).rejects.toThrow('blocked address');

        expect(mocks.safeFetch).toHaveBeenCalledTimes(1);
    });

    it('returns absolute feed URLs from HTML alternate links', async () => {
        mocks.safeFetch.mockImplementation(async (url: string) => {
            if (url === 'https://example.com/') {
                return safeFetchResult(
                    '<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml" title="Main RSS"></head></html>',
                    'text/html; charset=utf-8'
                );
            }
            return safeFetchResult('', '', false);
        });

        const feeds = await discoverFeeds('https://example.com');

        expect(feeds).toEqual([{
            url: 'https://example.com/rss.xml',
            title: 'Main RSS',
            type: 'RSS',
        }]);
    });

    it('ignores fallback common feed path failures', async () => {
        mocks.safeFetch.mockImplementation(async (url: string) => {
            if (url === 'https://example.com/') {
                return safeFetchResult('<html><head></head><body>No feeds here</body></html>', 'text/html');
            }
            throw new Error(`probe failed for ${url}`);
        });

        await expect(discoverFeeds('https://example.com')).resolves.toEqual([]);
        expect(mocks.safeFetch).toHaveBeenCalledTimes(6);
    });

    it('discovers feeds from common feed paths', async () => {
        mocks.safeFetch.mockImplementation(async (url: string) => {
            if (url === 'https://example.com/') {
                return safeFetchResult('<html><head></head><body>No feeds here</body></html>', 'text/html');
            }
            if (url === 'https://example.com/feed') {
                return safeFetchResult('<?xml version="1.0"?><rss><channel></channel></rss>', 'application/rss+xml');
            }
            return safeFetchResult('', '', false);
        });

        const feeds = await discoverFeeds('https://example.com');

        expect(feeds).toEqual([{
            url: 'https://example.com/feed',
            type: 'RSS',
        }]);
        expect(mocks.safeFetch).toHaveBeenCalledWith('https://example.com/feed', {
            timeoutMs: 5000,
            rateLimit: false,
        });
    });
});
