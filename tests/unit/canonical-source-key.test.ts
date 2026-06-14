import { describe, it, expect } from 'vitest';
import { canonicalSourceKey } from '../../src/utils/canonical-source-key.js';

describe('canonicalSourceKey', () => {
    it('lowercases host, strips www, forces https, drops trailing slash', () => {
        expect(canonicalSourceKey('HTTP://WWW.Example.com/Feed/')).toBe('https://example.com/feed');
    });

    it('treats http/https + www variants as the same key', () => {
        const a = canonicalSourceKey('http://www.site.com/rss');
        const b = canonicalSourceKey('https://site.com/rss/');
        expect(a).toBe(b);
    });

    it('strips tracking params but keeps meaningful query', () => {
        expect(canonicalSourceKey('https://news.com/feed?utm_source=x&cat=politics&fbclid=y'))
            .toBe('https://news.com/feed?cat=politics');
    });

    it('is order-independent for query params', () => {
        const a = canonicalSourceKey('https://news.com/feed?b=2&a=1');
        const b = canonicalSourceKey('https://news.com/feed?a=1&b=2');
        expect(a).toBe(b);
    });

    it('returns empty string for empty input', () => {
        expect(canonicalSourceKey('')).toBe('');
    });
});
