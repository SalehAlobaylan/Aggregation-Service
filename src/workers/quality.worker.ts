/**
 * Quality Re-encode Worker
 *
 * One job per content item. The heavy lifting (download → ffmpeg → upload →
 * CMS patch → history) lives in services/quality.service.ts; this file is the
 * BullMQ adapter plus grace-period cleanup for the prior version.
 *
 * Cleanup pattern: after a successful re-encode the worker enqueues a delayed
 * `cleanup-old-version` job onto the same queue, fired 5 minutes later. That
 * delay lets in-flight CDN reads of the old URL drain before we delete the
 * underlying object. Deletes are best-effort; failure is logged but never
 * rolled back into history.
 */
import type { Job, Queue } from 'bullmq';
import { createWorker } from './base-worker.js';
import {
    QUEUE_NAMES,
    type QualityReencodeJob,
    type QualityCleanupJob,
} from '../queues/index.js';
import { getQueue } from '../queues/index.js';
import { reencodeOneItem, deleteOldVersion } from '../services/quality.service.js';

const CLEANUP_GRACE_MS = 5 * 60 * 1000; // 5 min

/**
 * BullMQ worker for the QUALITY_REENCODE queue.
 *
 * Two job names share the queue:
 *   - default name (anything other than 'cleanup-old-version'): a fresh
 *     re-encode → calls reencodeOneItem.
 *   - 'cleanup-old-version': delayed deletion of the prior versioned key.
 */
export const qualityWorker = createWorker({
    queueName: QUEUE_NAMES.QUALITY_REENCODE,
    concurrency: 1, // ffmpeg is CPU-heavy; one at a time per replica
    timeoutMs: 30 * 60 * 1000, // 30 min — long videos can take a while
    processor: async (job: Job, jobLogger): Promise<void> => {
        if (job.name === 'cleanup-old-version') {
            const data = job.data as QualityCleanupJob;
            jobLogger.info('Quality cleanup tick', {
                contentItemId: data.contentItemId,
                key: data.keyToDelete,
                tier: data.tier,
            });
            await deleteOldVersion(data.keyToDelete, data.tier);
            return;
        }

        const data = job.data as QualityReencodeJob;
        jobLogger.info('Quality re-encode tick', {
            contentItemId: data.contentItemId,
            targetProfileId: data.targetProfileId,
            trigger: data.trigger,
        });

        const result = await reencodeOneItem({
            contentItemId: data.contentItemId,
            targetProfileId: data.targetProfileId,
            tenantId: data.tenantId,
            ruleId: data.ruleId,
            trigger: data.trigger,
        });

        if (!result.success) {
            if (result.nonRetryable) {
                jobLogger.warn('Quality re-encode skipped without retry', {
                    contentItemId: data.contentItemId,
                    error: result.error,
                    skippedMissingSource: result.skippedMissingSource,
                    sourceCandidates: result.sourceCandidates,
                });
                return;
            }
            // Bubble up so BullMQ retries (subject to attempts).
            throw new Error(result.error ?? 'unknown re-encode failure');
        }

        // Idempotent skips don't have an old key to clean up.
        if (result.skippedIdempotent) return;

        // Schedule the prior key for deletion after the grace period. Tier
        // MUST come from the result — cold-tier items have their old key on
        // the cold bucket, not primary.
        if (result.oldKey && result.newKey && result.oldKey !== result.newKey) {
            const queue = getQueue(QUEUE_NAMES.QUALITY_REENCODE) as Queue | undefined;
            if (queue) {
                const cleanup: QualityCleanupJob = {
                    contentItemId: data.contentItemId,
                    keyToDelete: result.oldKey,
                    tier: result.tier,
                };
                await queue.add('cleanup-old-version', cleanup, {
                    delay: CLEANUP_GRACE_MS,
                    attempts: 3,
                    removeOnComplete: { age: 86400, count: 100 },
                    removeOnFail: { age: 86400 },
                });
                jobLogger.info('Quality cleanup scheduled', {
                    contentItemId: data.contentItemId,
                    key: result.oldKey,
                    tier: result.tier,
                    delayMs: CLEANUP_GRACE_MS,
                });
            }
        }
    },
});
