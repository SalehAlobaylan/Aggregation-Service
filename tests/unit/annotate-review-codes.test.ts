import { describe, expect, it } from 'vitest';
import { annotateReviewCodes } from '../../src/workers/atomization.helpers.js';
import type { AtomizationChapter } from '../../src/cms/types.js';

// Stage 6 (S4/S5): Aggregation emits the review-reason code(s) it used so the
// CMS Studio Autopilot trust gate keys on a fixed taxonomy. These assert the
// code emission per constant + precedence + single-code detection.

function chapter(overrides: Partial<AtomizationChapter>): AtomizationChapter {
    return {
        title: 'C',
        start_ms: 0,
        end_ms: 300_000,
        confidence: 0.9,
        contains_sponsor_intro: false,
        needs_review_reason: null,
        ...overrides,
    };
}

describe('annotateReviewCodes', () => {
    it('codes short_unmergeable from its constant', () => {
        const [c] = annotateReviewCodes(
            [chapter({ needs_review_reason: 'Chapter below 4:30 and cannot merge without exceeding hard max.' })],
            0.82
        );
        expect(c!.needs_review_code).toBe('short_unmergeable');
        expect(c!.needs_review_codes).toEqual(['short_unmergeable']);
    });

    it('codes below_min and above_hard_max', () => {
        const [a] = annotateReviewCodes(
            [chapter({ needs_review_reason: 'Chapter is below the 4:30 minimum feed duration.' })],
            0.82
        );
        expect(a!.needs_review_code).toBe('below_min');
        const [b] = annotateReviewCodes(
            [chapter({ needs_review_reason: 'Chapter exceeds hard maximum duration.' })],
            0.82
        );
        expect(b!.needs_review_code).toBe('above_hard_max');
    });

    it('codes planner_fallback', () => {
        const [c] = annotateReviewCodes(
            [chapter({ needs_review_reason: 'Fallback single chapter; planner returned no usable chapters.' })],
            0.82
        );
        expect(c!.needs_review_code).toBe('planner_fallback');
    });

    it('sponsor outranks low_confidence (precedence) and both appear in the set', () => {
        const [c] = annotateReviewCodes(
            [chapter({ confidence: 0.5, contains_sponsor_intro: true })],
            0.82
        );
        expect(c!.needs_review_code).toBe('sponsor_intro');
        expect(c!.needs_review_codes).toContain('low_confidence');
        expect(c!.needs_review_codes).toContain('sponsor_intro');
    });

    it('merged_short suppresses low_confidence so it can be single-code', () => {
        const [c] = annotateReviewCodes(
            [chapter({ confidence: 0.5, boundary_reason: 'merged_short_chapter' })],
            0.82
        );
        expect(c!.needs_review_code).toBe('merged_short');
        expect(c!.needs_review_codes).toEqual(['merged_short']);
    });

    it('clean high-confidence chapter is unclassified', () => {
        const [c] = annotateReviewCodes([chapter({ confidence: 0.95 })], 0.82);
        expect(c!.needs_review_code).toBeNull();
        expect(c!.needs_review_codes).toEqual([]);
    });
});
