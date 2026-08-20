import { describe, expect, it } from 'vitest';
import { shouldContinueYoutubePagination, youtubeCandidateLimit } from '../../src/fetchers/youtube.fetcher.js';

describe('youtubeCandidateLimit', () => {
    it('overfetches a bounded candidate window when duration filtering is active', () => {
        expect(youtubeCandidateLimit(3, 270)).toBe(12);
        expect(youtubeCandidateLimit(20, 270)).toBe(50);
    });

    it('keeps the requested provider limit when no duration filter is active', () => {
        expect(youtubeCandidateLimit(3)).toBe(3);
    });
});

describe('shouldContinueYoutubePagination', () => {
    it('continues after an all-Shorts page when the provider has another cursor', () => {
        expect(shouldContinueYoutubePagination('next-page', 0, 10)).toBe(true);
    });

    it('stops only after the accepted target is satisfied or cursor is exhausted', () => {
        expect(shouldContinueYoutubePagination('next-page', 10, 10)).toBe(false);
        expect(shouldContinueYoutubePagination(undefined, 0, 10)).toBe(false);
        expect(shouldContinueYoutubePagination('same-page', 0, 10, 'same-page')).toBe(false);
    });
});
