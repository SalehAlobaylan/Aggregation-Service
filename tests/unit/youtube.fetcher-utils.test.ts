import { describe, expect, it } from 'vitest';
import { youtubeCandidateLimit } from '../../src/fetchers/youtube.fetcher.js';

describe('youtubeCandidateLimit', () => {
    it('overfetches a bounded candidate window when duration filtering is active', () => {
        expect(youtubeCandidateLimit(3, 270)).toBe(12);
        expect(youtubeCandidateLimit(20, 270)).toBe(50);
    });

    it('keeps the requested provider limit when no duration filter is active', () => {
        expect(youtubeCandidateLimit(3)).toBe(3);
    });
});
