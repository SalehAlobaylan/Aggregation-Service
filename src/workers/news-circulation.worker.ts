/**
 * News Circulation Worker — adaptive source pulling.
 *
 * CMS owns policy and due-source decisions. This worker periodically claims
 * due news sources, enqueues normal fetch jobs, and lets fetch/normalize
 * telemetry drive CMS recommendations.
 */
import { Job, Queue } from 'bullmq';
import { getQueue, QUEUE_NAMES, type FetchJob, type NewsCirculationJob } from '../queues/index.js';
import { createWorker } from './base-worker.js';
import { cmsClient } from '../cms/client.js';
import { logger } from '../observability/logger.js';

const REPEATABLE_NAME = 'news-circulation-repeatable';

export const newsCirculationWorker = createWorker({
    queueName: QUEUE_NAMES.NEWS_CIRCULATION,
    processor: async (job: Job<NewsCirculationJob>, jobLogger): Promise<void> => {
        const tenantId = job.data.tenantId || 'default';
        const fetchQueue = getQueue(QUEUE_NAMES.FETCH);
        if (!fetchQueue) {
            jobLogger.warn('News circulation skipped: fetch queue unavailable');
            return;
        }
        const force = job.data.trigger === 'manual';
        // Batch size is a policy knob owned by CMS (source_claim_batch_size); pass 0
        // so CMS applies the configured batch instead of a hardcoded ceiling here.
        const recovery = job.data.recovery;
        const claimLimit = recovery ? Math.min(recovery.sourceIds.length, 200) : 0;
        const claimed = await cmsClient.claimCirculationSources(tenantId, claimLimit, force, job.id, recovery);

        let enqueued = 0;
        for (const source of claimed.data ?? []) {
            const recoverySettings = recovery ? {
                recovery: {
                    run_id: recovery.runId,
                    manifest_hash: recovery.manifestHash,
                    lane: recovery.lane,
                    lookback_hours: recovery.lookbackHours,
                    preserve_checkpoints: recovery.preserveCheckpoints,
                },
            } : {};
            const fetchJob: FetchJob = {
                sourceId: source.id,
                sourceType: source.type,
                config: {
                    name: source.name,
                    url: source.url,
                    settings: {
                        ...(source.settings ?? {}),
                        ...recoverySettings,
                        circulation: {
                            tenantId,
                            sourceId: source.id,
                        },
                    },
                    pollIntervalMs: source.fetch_interval_minutes * 60_000,
                },
                triggeredBy: job.data.trigger === 'manual' ? 'manual' : 'schedule',
                triggeredAt: new Date().toISOString(),
            };
            await fetchQueue.add(`circulation-${source.type}-${source.id}-${Date.now()}`, fetchJob, {
                priority: job.data.trigger === 'manual' ? 1 : 3,
            });
            enqueued++;
        }

        jobLogger.info('News circulation claimed sources', {
            tenantId,
            claimed: claimed.data?.length ?? 0,
            enqueued,
        });
    },
});

export async function syncNewsCirculationSweeper(): Promise<void> {
    const queue = getQueue(QUEUE_NAMES.NEWS_CIRCULATION) as Queue | undefined;
    if (!queue) {
        logger.warn('news circulation: queue not initialized; skipping sync');
        return;
    }

    const repeatables = await queue.getRepeatableJobs().catch(() => []);
    await Promise.all(
        repeatables
            .filter((entry) => entry.name === REPEATABLE_NAME)
            .map((entry) => queue.removeRepeatableByKey(entry.key).catch(() => undefined))
    );

    let intervalMinutes = 15;
    try {
        const policy = await cmsClient.getCirculationPolicy('default');
        intervalMinutes = Math.max(1, policy.source_claim_interval_minutes || 15);
    } catch (error) {
        logger.warn('news circulation: could not read CMS policy; using default interval', { error });
    }

    const every = intervalMinutes * 60_000;
    await queue.add(
        REPEATABLE_NAME,
        { trigger: 'auto', tenantId: 'default' } satisfies NewsCirculationJob,
        {
            repeat: { every },
            jobId: REPEATABLE_NAME,
        }
    );
    logger.info('news circulation: registered repeatable source claim', { intervalMinutes });
}
