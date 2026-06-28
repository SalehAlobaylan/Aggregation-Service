import { Job, Queue } from 'bullmq';
import { createWorker } from './base-worker.js';
import { getQueue, QUEUE_NAMES, type AIJob, type AtomizationJob, type AtomizationSweepJob } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { logger } from '../observability/logger.js';

const ATOMIZATION_SWEEP_REPEATABLE_NAME = 'atomization-candidate-sweep-auto';
const ATOMIZATION_SWEEP_INTERVAL_MS = 5 * 60_000;
const ATOMIZATION_SWEEP_BATCH = 25;

export const atomizationSweepWorker = createWorker({
    queueName: QUEUE_NAMES.ATOMIZATION_SWEEP,
    concurrency: 1,
    processor: async (job: Job<AtomizationSweepJob>, jobLogger): Promise<void> => {
        const tenantId = job.data.tenantId || 'default';
        try {
            const repair = await cmsClient.repairAtomizationLeaks(tenantId, job.id);
            if (repair.updated_count > 0) {
                jobLogger.info('Atomization sweep repaired feed invariants before candidate selection', {
                    tenantId,
                    updated: repair.updated_count,
                    archivedShortParentChildren: repair.archived_short_parent_child_count ?? 0,
                    hiddenDurationViolations: repair.hidden_duration_violation_count ?? 0,
                    remainingDurationViolations: repair.remaining_count,
                });
            }
        } catch (error) {
            jobLogger.warn('Atomization sweep: preflight repair failed; continuing candidate selection', {
                tenantId,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
        const { items, transcript_candidates: transcriptCandidates = [] } = await cmsClient.listAtomizationCandidates(ATOMIZATION_SWEEP_BATCH, tenantId, job.id);
        const aiQueue = getQueue(QUEUE_NAMES.AI);
        let transcriptEnqueued = 0;
        if (aiQueue) {
            for (const item of transcriptCandidates) {
                if (!item.media_url) continue;
                const jobId = `atomization-transcript-${item.id}`;
                const existing = await aiQueue.getJob(jobId);
                if (existing) {
                    const state = await existing.getState();
                    if (state !== 'failed' && state !== 'completed') {
                        continue;
                    }
                    await existing.remove();
                }
                await aiQueue.add(
                    `atomization-transcript-${item.id}`,
                    {
                        contentItemId: item.id,
                        contentType: item.type,
                        operations: ['transcript'],
                        textContent: {
                            title: item.title ?? '',
                            excerpt: item.excerpt ?? undefined,
                            bodyText: item.body_text ?? undefined,
                        },
                        mediaUrl: item.media_url,
                        heroImageUrl: item.thumbnail_url ?? undefined,
                        forceStt: true,
                    } satisfies AIJob,
                    {
                        priority: job.data.trigger === 'manual' ? 1 : 3,
                        jobId,
                        removeOnComplete: { age: 3600, count: 200 },
                        removeOnFail: { age: 86400 },
                    }
                );
                try {
                    await cmsClient.reportAtomizationRun(
                        item.id,
                        { status: 'queued', phase: 'planning' },
                        job.id
                    );
                } catch (error) {
                    jobLogger.warn('Atomization sweep: failed to report transcript queued state', {
                        contentItemId: item.id,
                        error: error instanceof Error ? error.message : 'Unknown error',
                    });
                }
                transcriptEnqueued++;
            }
        } else if (transcriptCandidates.length > 0) {
            jobLogger.warn('Atomization sweep: AI queue not initialized; cannot request transcripts', {
                tenantId,
                waitingTranscript: transcriptCandidates.length,
            });
        }

        if (items.length === 0) {
            jobLogger.info('Atomization sweep: no transcript-ready parents found', {
                tenantId,
                transcriptCandidates: transcriptCandidates.length,
                transcriptEnqueued,
            });
            return;
        }

        const atomizationQueue = getQueue(QUEUE_NAMES.ATOMIZATION);
        if (!atomizationQueue) {
            jobLogger.warn('Atomization sweep: atomization queue not initialized');
            return;
        }

        let enqueued = 0;
        for (const item of items) {
            const jobId = `atomize-${item.id}`;
            const existing = await atomizationQueue.getJob(jobId);
            if (existing) {
                const state = await existing.getState();
                if (state === 'failed' || state === 'completed') {
                    await existing.remove();
                } else {
                    continue;
                }
            }

            await atomizationQueue.add(
                jobId,
                { contentItemId: item.id, reason: 'sweeper' } satisfies AtomizationJob,
                {
                    priority: job.data.trigger === 'manual' ? 1 : 4,
                    jobId,
                    removeOnComplete: { age: 3600, count: 200 },
                    removeOnFail: { age: 86400 },
                }
            );
            try {
                await cmsClient.reportAtomizationRun(
                    item.id,
                    { status: 'queued', phase: 'planning' },
                    job.id
                );
            } catch (error) {
                jobLogger.warn('Atomization sweep: failed to report queued state', {
                    contentItemId: item.id,
                    error: error instanceof Error ? error.message : 'Unknown error',
                });
            }
            enqueued++;
        }

        jobLogger.info('Atomization sweep enqueued candidates', {
            tenantId,
            found: items.length,
            enqueued,
            transcriptCandidates: transcriptCandidates.length,
            transcriptEnqueued,
        });
    },
});

export async function syncAtomizationSweeper(): Promise<void> {
    const queue = getQueue(QUEUE_NAMES.ATOMIZATION_SWEEP) as Queue | undefined;
    if (!queue) {
        logger.warn('atomization sweep worker: queue not initialized; skipping sync');
        return;
    }

    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
        if (job.name.startsWith(ATOMIZATION_SWEEP_REPEATABLE_NAME)) {
            await queue.removeRepeatableByKey(job.key);
        }
    }

    await queue.add(
        ATOMIZATION_SWEEP_REPEATABLE_NAME,
        { trigger: 'auto', tenantId: 'default' } satisfies AtomizationSweepJob,
        {
            repeat: { every: ATOMIZATION_SWEEP_INTERVAL_MS },
            removeOnComplete: { age: 3600, count: 50 },
            removeOnFail: { age: 86400 },
        }
    );
    logger.info('atomization sweep worker: registered repeatable candidate sweep', {
        intervalMs: ATOMIZATION_SWEEP_INTERVAL_MS,
        batch: ATOMIZATION_SWEEP_BATCH,
    });
}

export { ATOMIZATION_SWEEP_BATCH, ATOMIZATION_SWEEP_INTERVAL_MS, ATOMIZATION_SWEEP_REPEATABLE_NAME };
