import { describe, expect, it, vi } from 'vitest';
import {
    aiPriorityForContentType,
    reprioritizePendingMediaAIJobs,
} from '../../src/services/ai-queue-priority.js';

describe('AI queue priority', () => {
    it('lets feed-blocking media completion run ahead of text enrichment', () => {
        expect(aiPriorityForContentType('VIDEO')).toBe(1);
        expect(aiPriorityForContentType('PODCAST')).toBe(1);
        expect(aiPriorityForContentType('NEWS')).toBe(2);
    });

    it('repairs only pending media jobs from the bounded startup scan', async () => {
        const mediaChange = vi.fn().mockResolvedValue(undefined);
        const textChange = vi.fn().mockResolvedValue(undefined);
        const queue = {
            getJobs: vi.fn().mockResolvedValue([
                { data: { contentType: 'VIDEO' }, opts: { priority: 2 }, changePriority: mediaChange },
                { data: { contentType: 'NEWS' }, opts: { priority: 2 }, changePriority: textChange },
                { data: { contentType: 'PODCAST' }, opts: { priority: 1 }, changePriority: vi.fn() },
            ]),
        };

        await expect(reprioritizePendingMediaAIJobs(queue as never)).resolves.toBe(1);
        expect(queue.getJobs).toHaveBeenCalledWith(['prioritized', 'waiting'], 0, 4_999, false);
        expect(mediaChange).toHaveBeenCalledWith({ priority: 1 });
        expect(textChange).not.toHaveBeenCalled();
    });
});
