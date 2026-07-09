/**
 * Unit tests for enqueueRetryJob — the shared routing the retry scripts +
 * admin retry endpoints use. The bug this guards against: Telegram TEXT posts
 * (no media, no downloadRef) being pushed onto the media queue, where they fail
 * with "Missing Telegram downloadRef for media job" and loop into the DLQ.
 */
import { describe, expect, it, vi } from 'vitest';
import { enqueueRetryJob, type RetryItem } from '../../src/queues/retry-routing.js';

function mkQueues() {
    return {
        media: {
            add: vi.fn().mockResolvedValue(undefined),
            getJob: vi.fn().mockResolvedValue(null),
        },
        ai: {
            add: vi.fn().mockResolvedValue(undefined),
            getJob: vi.fn().mockResolvedValue(null),
        },
    };
}

const base = { id: 'c1', original_url: 'https://t.me/x/1' };

describe('enqueueRetryJob', () => {
    it('routes Telegram text posts to the AI queue (embedding-only)', async () => {
        const q = mkQueues();
        const item: RetryItem = {
            ...base,
            type: 'ARTICLE',
            source: 'TELEGRAM',
            title: 'T',
            body_text: 'B',
            metadata: { mediaKind: 'text' },
        };
        const route = await enqueueRetryJob(q as never, item, {
            namePrefix: 'retry-media',
            priority: 3,
        });
        expect(route).toBe('ai');
        expect(q.ai.add).toHaveBeenCalledOnce();
        expect(q.media.add).not.toHaveBeenCalled();
        const data = q.ai.add.mock.calls[0][1];
        expect(data.operations).toEqual(['embedding']);
        expect(data.textContent.title).toBe('T');
        expect(data.textContent.bodyText).toBe('B');
    });

    it('routes NEWS (RSS article) to the AI queue, never media download', async () => {
        const q = mkQueues();
        const item: RetryItem = {
            id: 'c1',
            original_url: 'https://sa.investing.com/news/article-93CH-3283147',
            type: 'NEWS',
            source: 'RSS',
            title: 'Headline',
            body_text: 'Body',
            metadata: {},
        };
        const route = await enqueueRetryJob(q as never, item, {
            namePrefix: 'retry-pending',
            priority: 3,
        });
        expect(route).toBe('ai');
        expect(q.media.add).not.toHaveBeenCalled();
        expect(q.ai.add).toHaveBeenCalledOnce();
        expect(q.ai.add.mock.calls[0][1].operations).toEqual(['embedding']);
    });

    it('routes NEWS (TWITTER) to the AI queue, never media download', async () => {
        const q = mkQueues();
        const item: RetryItem = {
            id: 'c1',
            original_url: 'https://x.com/mojksa/status/2069406146750750830',
            type: 'NEWS',
            source: 'TWITTER',
            metadata: {},
        };
        const route = await enqueueRetryJob(q as never, item, {
            namePrefix: 'retry-pending',
            priority: 3,
        });
        expect(route).toBe('ai');
        expect(q.media.add).not.toHaveBeenCalled();
        expect(q.ai.add).toHaveBeenCalledOnce();
    });

    it('skips text items when no AI queue is available', async () => {
        const q = { media: { add: vi.fn().mockResolvedValue(undefined) } };
        const item: RetryItem = {
            id: 'c1',
            original_url: 'https://sa.investing.com/news/x',
            type: 'NEWS',
            source: 'RSS',
            metadata: {},
        };
        const route = await enqueueRetryJob(q as never, item, {
            namePrefix: 'retry-pending',
            priority: 3,
        });
        expect(route).toBe('skipped');
        expect(q.media.add).not.toHaveBeenCalled();
    });

    it('routes Telegram photo posts to the media queue (download-only)', async () => {
        const q = mkQueues();
        const item: RetryItem = {
            ...base,
            type: 'ARTICLE',
            source: 'TELEGRAM',
            metadata: { mediaKind: 'photo' },
        };
        const route = await enqueueRetryJob(q as never, item, {
            namePrefix: 'retry-media',
            priority: 3,
        });
        expect(route).toBe('media');
        expect(q.ai.add).not.toHaveBeenCalled();
        expect(q.media.add.mock.calls[0][1].operations).toEqual(['download']);
        expect(q.media.add.mock.calls[0][2]).toEqual(expect.objectContaining({
            jobId: 'media-c1',
        }));
    });

    it('routes video to the media queue (full pipeline)', async () => {
        const q = mkQueues();
        const item: RetryItem = {
            ...base,
            type: 'VIDEO',
            source: 'YOUTUBE',
            metadata: {},
        };
        const route = await enqueueRetryJob(q as never, item, {
            namePrefix: 'retry-media',
            priority: 3,
        });
        expect(route).toBe('media');
        expect(q.media.add.mock.calls[0][1].operations).toEqual([
            'download',
            'transcode',
            'thumbnail',
        ]);
        expect(q.media.add.mock.calls[0][2]).toEqual(expect.objectContaining({
            jobId: 'media-c1',
        }));
    });

    it('keeps deterministic AI job ids for text retries', async () => {
        const q = mkQueues();
        const item: RetryItem = {
            ...base,
            type: 'NEWS',
            source: 'RSS',
            title: 'Headline',
            metadata: {},
        };

        await enqueueRetryJob(q as never, item, {
            namePrefix: 'retry-pending',
            priority: 3,
        });

        expect(q.ai.add.mock.calls[0][2]).toEqual(expect.objectContaining({
            jobId: 'ai-c1',
        }));
    });

    it('removes stale failed media retry jobs before requeueing', async () => {
        const q = mkQueues();
        const remove = vi.fn().mockResolvedValue(undefined);
        q.media.getJob.mockResolvedValue({
            getState: vi.fn().mockResolvedValue('failed'),
            remove,
        });
        const item: RetryItem = {
            ...base,
            type: 'VIDEO',
            source: 'YOUTUBE',
            metadata: {},
        };

        const route = await enqueueRetryJob(q as never, item, {
            namePrefix: 'retry-media',
            priority: 3,
        });

        expect(route).toBe('media');
        expect(remove).toHaveBeenCalledOnce();
        expect(q.media.add).toHaveBeenCalledOnce();
    });

    it('coalesces active media retry jobs without enqueueing a duplicate', async () => {
        const q = mkQueues();
        const remove = vi.fn();
        q.media.getJob.mockResolvedValue({
            getState: vi.fn().mockResolvedValue('active'),
            remove,
        });
        const item: RetryItem = {
            ...base,
            type: 'VIDEO',
            source: 'YOUTUBE',
            metadata: {},
        };

        const route = await enqueueRetryJob(q as never, item, {
            namePrefix: 'retry-media',
            priority: 3,
        });

        expect(route).toBe('media');
        expect(remove).not.toHaveBeenCalled();
        expect(q.media.add).not.toHaveBeenCalled();
    });

    it('removes stale completed AI retry jobs before requeueing', async () => {
        const q = mkQueues();
        const remove = vi.fn().mockResolvedValue(undefined);
        q.ai.getJob.mockResolvedValue({
            getState: vi.fn().mockResolvedValue('completed'),
            remove,
        });
        const item: RetryItem = {
            ...base,
            type: 'NEWS',
            source: 'RSS',
            title: 'Headline',
            metadata: {},
        };

        const route = await enqueueRetryJob(q as never, item, {
            namePrefix: 'retry-pending',
            priority: 3,
        });

        expect(route).toBe('ai');
        expect(remove).toHaveBeenCalledOnce();
        expect(q.ai.add).toHaveBeenCalledOnce();
    });
});
