import type { Job, Queue } from 'bullmq';
import { getQueue, QUEUE_NAMES } from '../queues/index.js';

export const MEDIA_AI_PRIORITY = 1;
export const TEXT_AI_PRIORITY = 2;
const STARTUP_REPAIR_SCAN_LIMIT = 5_000;

export function aiPriorityForContentType(contentType: string): number {
    return contentType === 'VIDEO' || contentType === 'PODCAST'
        ? MEDIA_AI_PRIORITY
        : TEXT_AI_PRIORITY;
}

function isMediaAIJob(job: Job): boolean {
    const contentType = (job.data as { contentType?: unknown } | undefined)?.contentType;
    return contentType === 'VIDEO' || contentType === 'PODCAST';
}

/**
 * Repair pending jobs created before media completion received its own priority.
 * The scan is intentionally bounded; normal enqueue paths keep future work correct.
 */
export async function reprioritizePendingMediaAIJobs(
    queue: Queue | undefined = getQueue(QUEUE_NAMES.AI),
): Promise<number> {
    if (!queue) return 0;

    const jobs = await queue.getJobs(
        ['prioritized', 'waiting'],
        0,
        STARTUP_REPAIR_SCAN_LIMIT - 1,
        false,
    );
    const mediaJobs = jobs.filter((job) =>
        isMediaAIJob(job) && job.opts.priority !== MEDIA_AI_PRIORITY
    );

    await Promise.all(mediaJobs.map((job) =>
        job.changePriority({ priority: MEDIA_AI_PRIORITY })
    ));

    return mediaJobs.length;
}
