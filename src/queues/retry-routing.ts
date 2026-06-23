/**
 * Shared routing for re-enqueued content items (retry scripts + admin retry
 * endpoints). The normal ingest path (normalize.worker) already routes by
 * content shape; the retry paths historically did NOT, and blindly pushed every
 * item onto the media queue. Two failure modes resulted:
 *   - Telegram TEXT posts (no media, no downloadRef) hit the media worker and
 *     failed with "Missing Telegram downloadRef for media job".
 *   - NEWS items (RSS/TWITTER/WEBSITE text) were downloaded as media: the media
 *     worker fetched the article/tweet *page* URL, which either 403'd or saved an
 *     HTML body as .mp4, then failed ffprobe with "moov atom not found".
 *
 * This helper mirrors the normal-path guard (normalize.worker.ts) so all retry
 * sites agree. Only genuine A/V needs the media-download pipeline:
 *   - VIDEO / PODCAST                 → media queue (download/transcode/thumbnail)
 *   - Telegram photo                  → media queue (download-only)
 *   - everything else (NEWS/text)     → AI queue, embedding-only (no media to download)
 */
import type { Queue } from 'bullmq';
import type { AIJob, MediaJob } from './schemas.js';

export interface RetryItem {
    id: string;
    type: string;
    source: string;
    original_url: string;
    title?: string | null;
    excerpt?: string | null;
    body_text?: string | null;
    metadata?: Record<string, unknown> | null;
}

export type RetryRoute = 'media' | 'ai' | 'skipped';

export async function enqueueRetryJob(
    queues: { media: Queue<MediaJob>; ai?: Queue<AIJob> },
    item: RetryItem,
    opts: { namePrefix: string; priority: number },
): Promise<RetryRoute> {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const mediaKind = meta.mediaKind as string | undefined;
    const isPhoto = item.source === 'TELEGRAM' && mediaKind === 'photo';

    // Only genuine A/V needs the media-download pipeline. Mirror the normal-path
    // guard in normalize.worker.ts: VIDEO / PODCAST / Telegram-photo download;
    // everything else (NEWS/text from RSS/TWITTER/WEBSITE, Telegram text) is
    // text-only and goes to embedding — downloading its page URL would 403 or
    // save HTML that later fails ffprobe.
    const requiresMediaJob =
        item.type === 'VIDEO' || item.type === 'PODCAST' || isPhoto;

    if (!requiresMediaJob) {
        if (!queues.ai) return 'skipped';
        await queues.ai.add(
            `${opts.namePrefix}-embed-${item.source}-${item.id}`,
            {
                contentItemId: item.id,
                contentType: item.type as AIJob['contentType'],
                operations: ['embedding'],
                textContent: {
                    title: item.title || '',
                    excerpt: item.excerpt || undefined,
                    bodyText: item.body_text || undefined,
                },
            },
            // Deterministic id coalesces with the normal-path AI job for this item.
            { priority: opts.priority, jobId: `ai-${item.id}` },
        );
        return 'ai';
    }

    const downloadRef = meta.telegramDownloadRef as MediaJob['downloadRef'] | undefined;
    await queues.media.add(
        `${opts.namePrefix}-${item.source}-${item.id}`,
        {
            contentItemId: item.id,
            contentType: item.type as MediaJob['contentType'],
            sourceType: item.source as MediaJob['sourceType'],
            sourceUrl: item.original_url,
            operations: isPhoto ? ['download'] : ['download', 'transcode', 'thumbnail'],
            downloadRef,
        },
        { priority: opts.priority },
    );
    return 'media';
}
