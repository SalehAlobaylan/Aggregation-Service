import type { AIJob } from '../queues/index.js';
import type { GeneratedChapterPlan, ChapterWindowPayload } from '../ai/enrichment-client.js';
import type { AtomizationChapter, AtomizationInputResponse, AtomizationSegment } from '../cms/types.js';

const MAX_WINDOW_COUNT = 550;
const MIN_WINDOW_SEC = 12;
const DEFAULT_MIN_FEED_UNIT_SEC = 4 * 60 + 30;
const DEFAULT_ATOMIZATION_MIN_PARENT_SEC = 40 * 60;
const SHORT_CHAPTER_UNMERGEABLE_REASON = 'Chapter below 4:30 and cannot merge without exceeding hard max.';
const MIN_CHAPTER_REVIEW_REASON = 'Chapter is below the 4:30 minimum feed duration.';
const HARD_MAX_CHAPTER_REVIEW_REASON = 'Chapter exceeds hard maximum duration.';
const DURATION_BUCKET_MS = [5, 10, 15, 20, 30, 40].map(minutes => minutes * 60_000);

export function shouldAtomizeParent(durationSec?: number | null, minParentSec = DEFAULT_ATOMIZATION_MIN_PARENT_SEC): boolean {
    return typeof durationSec === 'number' && durationSec > minParentSec;
}

export function minFeedUnitSeconds(input: AtomizationInputResponse): number {
    return input.policy.min_feed_unit_seconds ?? DEFAULT_MIN_FEED_UNIT_SEC;
}

function minFeedUnitMs(input: AtomizationInputResponse): number {
    return minFeedUnitSeconds(input) * 1000;
}

export function windowSizeForSegments(segments: AtomizationSegment[]): number {
    const last = segments[segments.length - 1];
    if (!last) return MIN_WINDOW_SEC;
    return Math.max(MIN_WINDOW_SEC, last.end / MAX_WINDOW_COUNT);
}

export function buildWindows(segments: AtomizationSegment[]): ChapterWindowPayload[] {
    const windowSec = windowSizeForSegments(segments);
    const windows: ChapterWindowPayload[] = [];
    let index = 0;
    let curStart = segments[0]?.start ?? 0;
    let text = '';
    for (const seg of segments) {
        if (text && seg.end - curStart >= windowSec) {
            windows.push({ index, start_sec: curStart, text });
            index += 1;
            curStart = seg.start;
            text = '';
        }
        text = text ? `${text} ${seg.text.trim()}` : seg.text.trim();
    }
    if (text) windows.push({ index, start_sec: curStart, text });
    return windows;
}

export function normalizeGeneratedChapters(
    generated: GeneratedChapterPlan[],
    windows: ChapterWindowPayload[],
    input: AtomizationInputResponse
): AtomizationChapter[] {
    const byIndex = new Map(windows.map(w => [w.index, w]));
    const sorted = generated
        .filter(ch => byIndex.has(ch.start_index))
        .sort((a, b) => a.start_index - b.start_index)
        .slice(0, input.policy.max_chapters_per_parent);

    if (sorted.length === 0 && input.item.duration_sec) {
        sorted.push({
            start_index: windows[0]?.index ?? 0,
            end_index: windows[windows.length - 1]?.index ?? 0,
            title: String(input.item.title ?? 'Episode'),
            summary: null,
            confidence: 0.65,
            standalone_score: 0.65,
            needs_review_reason: 'Fallback single chapter; planner returned no usable chapters.',
        });
    }

    const durationMs = (input.item.duration_sec ?? 0) * 1000;
    const normalized = sorted.map((chapter, i) => {
        const start = byIndex.get(chapter.start_index)?.start_sec ?? 0;
        const nextStart = sorted[i + 1] ? byIndex.get(sorted[i + 1]!.start_index)?.start_sec : undefined;
        const explicitEnd = chapter.end_index != null ? endSecForWindow(chapter.end_index, windows, durationMs) : undefined;
        const endSec = explicitEnd ?? nextStart ?? (durationMs > 0 ? durationMs / 1000 : start + input.policy.soft_max_chapter_minutes * 60);
        const startMs = Math.max(0, Math.round(start * 1000));
        const endMs = Math.max(startMs + 1000, Math.round(endSec * 1000));
        const boundedEndMs = durationMs > 0 ? Math.min(endMs, durationMs) : endMs;
        const hardMaxMs = input.policy.hard_max_chapter_minutes * 60_000;
        const needsReview = chapter.needs_review_reason
            ?? (boundedEndMs - startMs > hardMaxMs ? HARD_MAX_CHAPTER_REVIEW_REASON : null);
        return {
            title: chapter.title,
            summary: chapter.summary ?? null,
            start_ms: startMs,
            end_ms: boundedEndMs,
            confidence: chapter.confidence ?? 0.72,
            context_label: chapter.context_label ?? null,
            boundary_reason: chapter.boundary_reason ?? null,
            standalone_score: chapter.standalone_score ?? chapter.confidence ?? 0.72,
            contains_sponsor_intro: chapter.contains_sponsor_or_intro ?? false,
            needs_review_reason: needsReview,
        };
    });
    return mergeShortChapters(normalized, input);
}

export function mergeShortChapters(chapters: AtomizationChapter[], input: AtomizationInputResponse): AtomizationChapter[] {
    const minMs = minFeedUnitMs(input);
    const hardMaxMs = input.policy.hard_max_chapter_minutes * 60_000;
    const merged = [...chapters].sort((a, b) => a.start_ms - b.start_ms);

    let changed = true;
    while (changed) {
        changed = false;
        const index = merged.findIndex(chapter => chapter.end_ms - chapter.start_ms < minMs);
        if (index < 0) break;

        const neighbor = chooseShortChapterNeighbor(merged, index, hardMaxMs);
        if (neighbor == null) {
            merged[index] = {
                ...merged[index]!,
                needs_review_reason: merged[index]!.needs_review_reason ?? SHORT_CHAPTER_UNMERGEABLE_REASON,
            };
            break;
        }

        const [first, second] = index < neighbor ? [index, neighbor] : [neighbor, index];
        const replacement = mergeChapterPair(merged[first]!, merged[second]!);
        merged.splice(first, 2, replacement);
        changed = true;
    }

    return merged.map(chapter => {
        const duration = chapter.end_ms - chapter.start_ms;
        if (duration < minMs) {
            return {
                ...chapter,
                needs_review_reason: chapter.needs_review_reason ?? MIN_CHAPTER_REVIEW_REASON,
            };
        }
        if (duration > hardMaxMs) {
            return {
                ...chapter,
                needs_review_reason: chapter.needs_review_reason ?? HARD_MAX_CHAPTER_REVIEW_REASON,
            };
        }
        return chapter;
    });
}

function chooseShortChapterNeighbor(chapters: AtomizationChapter[], index: number, hardMaxMs: number): number | null {
    const candidateIndexes = [index - 1, index + 1].filter(i => i >= 0 && i < chapters.length);
    const candidates = candidateIndexes
        .map(i => ({ index: i, score: shortMergeScore(chapters, index, i, hardMaxMs) }))
        .filter((candidate): candidate is { index: number; score: number } => candidate.score != null);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        if (index === 0) return a.index - b.index;
        if (a.index < index && b.index > index) return -1;
        if (a.index > index && b.index < index) return 1;
        return a.index - b.index;
    });
    return candidates[0]!.index;
}

function shortMergeScore(chapters: AtomizationChapter[], shortIndex: number, candidateIndex: number, hardMaxMs: number): number | null {
    const short = chapters[shortIndex]!;
    const candidate = chapters[candidateIndex]!;
    const start = Math.min(short.start_ms, candidate.start_ms);
    const end = Math.max(short.end_ms, candidate.end_ms);
    const combinedMs = end - start;
    if (combinedMs > hardMaxMs) return null;

    const sameContext = short.context_label && candidate.context_label && short.context_label === candidate.context_label ? 0 : 1;
    const gapMs = candidateIndex < shortIndex
        ? Math.max(0, short.start_ms - candidate.end_ms)
        : Math.max(0, candidate.start_ms - short.end_ms);
    const bucketDelta = Math.min(...DURATION_BUCKET_MS.map(bucket => Math.abs(bucket - combinedMs)));
    return (sameContext * 1_000_000_000) + gapMs + (bucketDelta / 100);
}

function mergeChapterPair(a: AtomizationChapter, b: AtomizationChapter): AtomizationChapter {
    const ordered = [a, b].sort((left, right) => left.start_ms - right.start_ms);
    const first = ordered[0]!;
    const second = ordered[1]!;
    const firstDuration = first.end_ms - first.start_ms;
    const secondDuration = second.end_ms - second.start_ms;
    const longer = firstDuration >= secondDuration ? first : second;
    const summary = [first.summary, second.summary].map(value => value?.trim()).filter(Boolean).join(' ');
    const boundaryReasons = [first.boundary_reason, second.boundary_reason, 'merged_short_chapter']
        .map(value => value?.trim())
        .filter((value, index, list): value is string => Boolean(value) && list.indexOf(value) === index);
    const reviewReasons = [first.needs_review_reason, second.needs_review_reason]
        .map(value => value?.trim())
        .filter((value, index, list): value is string => Boolean(value) && value !== MIN_CHAPTER_REVIEW_REASON && value !== SHORT_CHAPTER_UNMERGEABLE_REASON && list.indexOf(value) === index);

    return {
        title: longer.title,
        summary: summary || null,
        start_ms: first.start_ms,
        end_ms: second.end_ms,
        confidence: Math.min(first.confidence ?? 0.72, second.confidence ?? 0.72),
        context_label: first.context_label === second.context_label ? first.context_label : longer.context_label ?? first.context_label ?? second.context_label ?? null,
        boundary_reason: boundaryReasons.join('; '),
        standalone_score: Math.min(first.standalone_score ?? first.confidence ?? 0.72, second.standalone_score ?? second.confidence ?? 0.72),
        contains_sponsor_intro: Boolean(first.contains_sponsor_intro || second.contains_sponsor_intro),
        needs_review_reason: reviewReasons.length > 0 ? reviewReasons.join('; ') : null,
    };
}

export function endSecForWindow(index: number, windows: ChapterWindowPayload[], durationMs: number): number | undefined {
    const position = windows.findIndex(w => w.index === index);
    if (position < 0) return undefined;
    const next = windows[position + 1];
    if (next) return next.start_sec;
    return durationMs > 0 ? durationMs / 1000 : undefined;
}

export function sliceSegments(segments: AtomizationSegment[], startMs: number, endMs: number): AtomizationSegment[] {
    const startSec = startMs / 1000;
    const endSec = endMs / 1000;
    return segments
        .filter(seg => seg.end > startSec && seg.start < endSec)
        .map(seg => ({
            start: Math.max(0, seg.start - startSec),
            end: Math.max(0, Math.min(seg.end, endSec) - startSec),
            text: seg.text,
        }));
}

export function countReviewChapters(chapters: AtomizationChapter[], threshold: number): number {
    return chapters.filter(ch => (ch.confidence ?? 0) < threshold || !!ch.needs_review_reason).length;
}

export function buildChapterEmbeddingJobs(
    created: Array<{ id: string; feed_visibility: string }>,
    chapters: AtomizationChapter[],
    input: AtomizationInputResponse
): Array<{ name: string; data: AIJob; options: { priority: number; jobId: string } }> {
    const jobs: Array<{ name: string; data: AIJob; options: { priority: number; jobId: string } }> = [];
    for (let i = 0; i < created.length; i += 1) {
        const child = created[i]!;
        if (child.feed_visibility !== 'embedding_pending') continue;
        const chapter = chapters[i];
        if (!chapter) continue;
        const data: AIJob = {
            contentItemId: child.id,
            contentType: input.item.type,
            operations: ['embedding'],
            textContent: {
                title: chapter.title,
                excerpt: chapter.summary ?? undefined,
                bodyText: chapter.transcript_text,
            },
            mediaUrl: chapter.media_url,
            heroImageUrl: chapter.thumbnail_url,
        };
        jobs.push({
            name: `atomized-embed-${child.id}`,
            data,
            options: { priority: 2, jobId: `atomized-embed-${child.id}` },
        });
    }
    return jobs;
}

export {
    DEFAULT_ATOMIZATION_MIN_PARENT_SEC,
    DEFAULT_MIN_FEED_UNIT_SEC,
    HARD_MAX_CHAPTER_REVIEW_REASON,
    MAX_WINDOW_COUNT,
    MIN_CHAPTER_REVIEW_REASON,
    MIN_WINDOW_SEC,
    SHORT_CHAPTER_UNMERGEABLE_REASON,
};
