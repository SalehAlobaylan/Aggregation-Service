/**
 * Embedding Reconciliation Sweep Worker (H2 backstop)
 *
 * READY content can be marked READY only once its embedding persisted (the AI
 * worker gates on this). This sweep is the safety net: it periodically asks CMS
 * for any READY item STILL missing a dense embedding — items whose original AI
 * job exhausted its retries, plus historical rows from before the gate existed —
 * and re-enqueues an *embedding-only* AI job for each (never re-transcribes).
 *
 * Repeatable job scheduled by `syncReconcileSweeper()` on startup, interval +
 * batch size from config (RECONCILE_*).
 */
import { Job, Queue } from 'bullmq';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type AIJob, type ReconcileJob } from '../queues/index.js';
import { getQueue } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';

export const reconcileWorker = createWorker({
    queueName: QUEUE_NAMES.RECONCILE,
    concurrency: 1,
    processor: async (job: Job<ReconcileJob>, jobLogger): Promise<void> => {
        const { items } = await cmsClient.listMissingEmbedding(config.reconcileBatch, job.id);

        if (items.length === 0) {
            jobLogger.debug('Reconcile tick: no READY items missing an embedding');
            return;
        }

        const aiQueue = getQueue(QUEUE_NAMES.AI);
        if (!aiQueue) {
            jobLogger.warn('Reconcile tick: AI queue not initialized; skipping');
            return;
        }

        let enqueued = 0;
        for (const item of items) {
            const aiJob: AIJob = {
                contentItemId: item.id,
                contentType: item.type as AIJob['contentType'],
                operations: ['embedding'], // embedding-only — no re-transcribe
                textContent: {
                    title: item.title || '',
                    excerpt: item.excerpt || undefined,
                    bodyText: item.body_text || undefined,
                },
            };
            const jobId = `reconcile-embed-${item.id}`;

            // Deterministic jobIds dedup against ACTIVE work, but BullMQ also
            // silently ignores an add while a finished job with the same id is
            // still retained — a single failure (e.g. Enrichment cold start)
            // would wedge the item for the whole removeOnFail window with every
            // sweep no-oping. Clear finished remnants so the sweep can retry;
            // leave queued/active jobs alone (genuine dedup).
            const existing = await aiQueue.getJob(jobId);
            if (existing) {
                const state = await existing.getState();
                if (state === 'failed' || state === 'completed') {
                    await existing.remove();
                } else {
                    continue; // still queued/active — let it run
                }
            }

            await aiQueue.add(`reconcile-embed-${item.id}`, aiJob, {
                priority: 5, // below fresh ingestion
                jobId,
                removeOnComplete: { age: 3600, count: 200 },
                removeOnFail: { age: 86400 },
            });
            enqueued++;
        }

        jobLogger.info('Reconcile sweep enqueued embedding-only jobs', {
            found: items.length,
            enqueued,
        });
    },
});

const REPEATABLE_NAME = 'embedding-reconcile-auto';

/**
 * Register (or clear) the repeatable reconciliation sweep based on config.
 * Best-effort — call on startup; non-fatal if Redis/queue isn't ready.
 */
export async function syncReconcileSweeper(): Promise<void> {
    const queue = getQueue(QUEUE_NAMES.RECONCILE) as Queue | undefined;
    if (!queue) {
        logger.warn('reconcile worker: queue not initialized; skipping sync');
        return;
    }

    // Clear any existing repeatable(s) then re-register from current config.
    const existing = await queue.getRepeatableJobs();
    for (const j of existing) {
        if (j.name.startsWith(REPEATABLE_NAME)) {
            await queue.removeRepeatableByKey(j.key);
        }
    }

    if (!config.reconcileEnabled) {
        logger.info('reconcile worker: disabled (RECONCILE_ENABLED=false)');
        return;
    }

    await queue.add(
        REPEATABLE_NAME,
        { trigger: 'auto' } as ReconcileJob,
        {
            repeat: { every: config.reconcileIntervalMs },
            removeOnComplete: { age: 3600, count: 50 },
            removeOnFail: { age: 86400 },
        }
    );
    logger.info('reconcile worker: registered repeatable embedding sweep', {
        intervalMs: config.reconcileIntervalMs,
        batch: config.reconcileBatch,
    });
}
