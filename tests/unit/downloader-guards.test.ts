import { describe, expect, it } from 'vitest';
import {
    assertContentLengthWithinCap,
    boundedAppend,
    isAllowedYouTubeUrl,
} from '../../src/media/downloader.js';

describe('assertContentLengthWithinCap', () => {
    it('allows missing content-length headers', () => {
        expect(() => assertContentLengthWithinCap(null, 10)).not.toThrow();
    });

    it('allows declared sizes under the cap', () => {
        expect(() => assertContentLengthWithinCap('9', 10)).not.toThrow();
    });

    it('rejects declared sizes over the cap', () => {
        expect(() => assertContentLengthWithinCap('11', 10)).toThrow(/exceeds size cap/);
    });
});

describe('boundedAppend', () => {
    it('appends normally under the limit', () => {
        expect(boundedAppend('abc', 'def', 10)).toBe('abcdef');
    });

    it('keeps only the tail when the limit is exceeded', () => {
        expect(boundedAppend('abcdef', 'ghij', 5)).toBe('fghij');
    });
});

describe('isAllowedYouTubeUrl', () => {
    it('allows canonical YouTube hosts', () => {
        expect(isAllowedYouTubeUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
        expect(isAllowedYouTubeUrl('https://youtu.be/abc')).toBe(true);
    });

    it('rejects URLs that only contain youtube.com outside the hostname', () => {
        expect(isAllowedYouTubeUrl('https://example.com/watch?next=youtube.com')).toBe(false);
        expect(isAllowedYouTubeUrl('http://169.254.169.254/latest?u=youtube.com')).toBe(false);
    });
});
