import { describe, expect, it } from 'vitest';
import {
    buildChapterEmbeddingJobs,
    buildWindows,
    countReviewChapters,
    normalizeGeneratedChapters,
    shouldAtomizeParent,
    sliceSegments,
} from '../../src/workers/atomization.helpers.js';
import type { AtomizationInputResponse } from '../../src/cms/types.js';
import type { GeneratedChapterPlan } from '../../src/ai/enrichment-client.js';

const baseInput: AtomizationInputResponse = {
    item: {
        id: 'parent-1',
        tenant_id: 'default',
        type: 'PODCAST',
        title: 'Parent episode',
        source: 'PODCAST',
        duration_sec: 3600,
    },
    policy: {
        chaptering_enabled: true,
        auto_publish_high_confidence: true,
        parent_feed_visible: false,
        preserve_video: true,
        remove_sponsor_segments: true,
        min_chapter_minutes: 5,
        min_feed_unit_seconds: 270,
        soft_max_chapter_minutes: 30,
        hard_max_chapter_minutes: 40,
        atomization_min_parent_seconds: 2400,
        max_chapters_per_parent: 5,
        chaptering_mode: 'contextual',
        high_confidence_threshold: 0.82,
        preferred_playback_rendition: 'hls',
        fallback_playback_rendition: 'mp4',
        audio_only_allowed: true,
    },
    segments: [],
    existing_chapters: [],
};

describe('atomization helpers', () => {
    it('only atomizes parent media longer than 40 minutes', () => {
        expect(shouldAtomizeParent(null)).toBe(false);
        expect(shouldAtomizeParent(15 * 60)).toBe(false);
        expect(shouldAtomizeParent(40 * 60)).toBe(false);
        expect(shouldAtomizeParent((40 * 60) + 1)).toBe(true);
    });

    it('preserves explicit chapter end indexes instead of stretching to the next chapter', () => {
        const windows = [
            { index: 0, start_sec: 0, text: 'intro' },
            { index: 1, start_sec: 300, text: 'argument' },
            { index: 2, start_sec: 600, text: 'pause' },
            { index: 3, start_sec: 1200, text: 'new topic' },
            { index: 4, start_sec: 1500, text: 'closing' },
        ];
        const plan: GeneratedChapterPlan[] = [
            { start_index: 0, end_index: 1, title: 'First context', confidence: 0.91 },
            { start_index: 3, end_index: 4, title: 'Second context', confidence: 0.9 },
        ];

        const chapters = normalizeGeneratedChapters(plan, windows, baseInput);

        expect(chapters[0].start_ms).toBe(0);
        expect(chapters[0].end_ms).toBe(600_000);
        expect(chapters[1].start_ms).toBe(1_200_000);
    });

    it('marks over-hard-max chapters for review after duration bounding', () => {
        const windows = [
            { index: 0, start_sec: 0, text: 'start' },
            { index: 1, start_sec: 2700, text: 'too long' },
        ];

        const chapters = normalizeGeneratedChapters(
            [{ start_index: 0, end_index: 1, title: 'Long chapter', confidence: 0.95 }],
            windows,
            { ...baseInput, item: { ...baseInput.item, duration_sec: 3000 } }
        );

        expect(chapters[0].end_ms).toBe(3_000_000);
        expect(chapters[0].needs_review_reason).toBe('Chapter exceeds hard maximum duration.');
    });

    it('classifies 4:30 and 4:39 chapters as valid 5m feed units', () => {
        const windows = [
            { index: 0, start_sec: 0, text: 'start' },
            { index: 1, start_sec: 270, text: 'valid floor' },
            { index: 2, start_sec: 549, text: 'still valid' },
        ];

        const chapters = normalizeGeneratedChapters(
            [
                { start_index: 0, end_index: 0, title: 'Floor chapter', confidence: 0.95 },
                { start_index: 1, end_index: 1, title: 'Fuzzy chapter', confidence: 0.95 },
            ],
            windows,
            baseInput
        );

        expect(chapters[0].end_ms - chapters[0].start_ms).toBe(270_000);
        expect(chapters[1].end_ms - chapters[1].start_ms).toBe(279_000);
        expect(chapters.every(chapter => chapter.needs_review_reason == null)).toBe(true);
    });

    it('merges a short first chapter forward', () => {
        const windows = [
            { index: 0, start_sec: 0, text: 'start' },
            { index: 1, start_sec: 240, text: 'too short' },
            { index: 2, start_sec: 600, text: 'next topic' },
        ];

        const chapters = normalizeGeneratedChapters(
            [
                { start_index: 0, end_index: 0, title: 'Short intro', confidence: 0.95, context_label: 'same' },
                { start_index: 1, end_index: 1, title: 'Longer neighbor', confidence: 0.9, context_label: 'same' },
            ],
            windows,
            baseInput
        );

        expect(chapters).toHaveLength(1);
        expect(chapters[0].title).toBe('Longer neighbor');
        expect(chapters[0].start_ms).toBe(0);
        expect(chapters[0].end_ms).toBe(600_000);
        expect(chapters[0].confidence).toBe(0.9);
        expect(chapters[0].boundary_reason).toContain('merged_short_chapter');
        expect(chapters[0].needs_review_reason).toBeNull();
    });

    it('merges a short middle chapter with the best adjacent neighbor', () => {
        const windows = [
            { index: 0, start_sec: 0, text: 'first topic' },
            { index: 1, start_sec: 300, text: 'short bridge' },
            { index: 2, start_sec: 540, text: 'same context follow up' },
            { index: 3, start_sec: 900, text: 'next topic' },
        ];

        const chapters = normalizeGeneratedChapters(
            [
                { start_index: 0, end_index: 0, title: 'Previous topic', confidence: 0.92, context_label: 'different' },
                { start_index: 1, end_index: 1, title: 'Short bridge', confidence: 0.88, context_label: 'same' },
                { start_index: 2, end_index: 2, title: 'Same context neighbor', confidence: 0.9, context_label: 'same' },
            ],
            windows,
            baseInput
        );

        expect(chapters).toHaveLength(2);
        expect(chapters[0].title).toBe('Previous topic');
        expect(chapters[1].title).toBe('Same context neighbor');
        expect(chapters[1].start_ms).toBe(300_000);
        expect(chapters[1].end_ms).toBe(900_000);
        expect(chapters[1].boundary_reason).toContain('merged_short_chapter');
    });

    it('keeps an unmergeable short chapter review-only when every merge would exceed 40 minutes', () => {
        const windows = [
            { index: 0, start_sec: 0, text: 'very long' },
            { index: 1, start_sec: 2400, text: 'short tail' },
            { index: 2, start_sec: 2640, text: 'done' },
        ];

        const chapters = normalizeGeneratedChapters(
            [
                { start_index: 0, end_index: 0, title: 'Forty minute chapter', confidence: 0.95 },
                { start_index: 1, end_index: 1, title: 'Short tail', confidence: 0.95 },
            ],
            windows,
            { ...baseInput, item: { ...baseInput.item, duration_sec: 2640 } }
        );

        expect(chapters).toHaveLength(2);
        expect(chapters[1].end_ms - chapters[1].start_ms).toBeLessThan(270_000);
        expect(chapters[1].needs_review_reason).toBe('Chapter below 4:30 and cannot merge without exceeding hard max.');
    });


    it('slices transcript segments into chapter-relative timestamps', () => {
        const sliced = sliceSegments([
            { start: 10, end: 20, text: 'before' },
            { start: 25, end: 35, text: 'inside' },
            { start: 50, end: 70, text: 'overlap' },
        ], 20_000, 60_000);

        expect(sliced).toEqual([
            { start: 5, end: 15, text: 'inside' },
            { start: 30, end: 40, text: 'overlap' },
        ]);
    });

    it('counts review chapters from confidence and explicit review reasons', () => {
        expect(countReviewChapters([
            { title: 'Good', start_ms: 0, end_ms: 300_000, confidence: 0.9 },
            { title: 'Weak', start_ms: 300_000, end_ms: 600_000, confidence: 0.5 },
            { title: 'Boundary', start_ms: 600_000, end_ms: 900_000, confidence: 0.95, needs_review_reason: 'Boundary uncertain' },
        ], 0.82)).toBe(2);
    });

    it('builds embedding jobs only for embedding-pending children', () => {
        const jobs = buildChapterEmbeddingJobs(
            [
                { id: 'child-publish', feed_visibility: 'embedding_pending' },
                { id: 'child-review', feed_visibility: 'review' },
            ],
            [
                { title: 'Publish me', summary: 'Summary', start_ms: 0, end_ms: 300_000, transcript_text: 'Transcript', media_url: 'https://cdn/clip.mp4' },
                { title: 'Review me', start_ms: 300_000, end_ms: 600_000, transcript_text: 'Review transcript' },
            ],
            baseInput
        );

        expect(jobs).toHaveLength(1);
        expect(jobs[0].name).toBe('atomized-embed-child-publish');
        expect(jobs[0].data).toMatchObject({
            contentItemId: 'child-publish',
            contentType: 'PODCAST',
            operations: ['embedding'],
            textContent: {
                title: 'Publish me',
                excerpt: 'Summary',
                bodyText: 'Transcript',
            },
            mediaUrl: 'https://cdn/clip.mp4',
        });
        expect(jobs[0].options.jobId).toBe('atomized-embed-child-publish');
    });

    it('builds transcript windows with enough granularity for long episodes', () => {
        const windows = buildWindows([
            { start: 0, end: 10, text: 'a' },
            { start: 20, end: 40, text: 'b' },
            { start: 1000, end: 1010, text: 'c' },
        ]);

        expect(windows.length).toBeGreaterThan(1);
        expect(windows[0].text).toContain('a');
    });
});
