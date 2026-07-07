import { describe, expect, it } from 'vitest';
import { assertContentLengthWithinCap, boundedAppend } from '../../src/media/downloader.js';

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
