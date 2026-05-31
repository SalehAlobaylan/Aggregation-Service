/**
 * Shared routing for re-enqueued content items (retry scripts + admin retry
 * endpoints). The normal ingest path (normalize.worker) already routes by
 * content shape; the retry paths historically did NOT, and blindly pushed every
 * item onto the media queue — so Telegram TEXT posts (which have no media and
 * no downloadRef) hit the media worker and failed with
 * "Missing Telegram downloadRef for media job", looping into the DLQ.
 *
 * This helper centralizes the decision so all retry sites agree:
 *   - Telegram text post  → AI queue, embedding-only (no media to download)
 *   - everything else     → media queue (download/transcode/thumbnail; photo = download-only)
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

    // Telegram text post — no media; route to embedding, never the media queue.
    if (item.source === 'TELEGRAM' && mediaKind === 'text') {
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
    const isPhoto = item.source === 'TELEGRAM' && mediaKind === 'photo';
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
