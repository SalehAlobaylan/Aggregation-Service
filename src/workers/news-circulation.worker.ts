/**
 * News Circulation Worker — adaptive source pulling.
 *
 * CMS owns policy and due-source decisions. This worker periodically claims
 * due news sources, enqueues normal fetch jobs, and lets fetch/normalize
 * telemetry drive CMS recommendations.
 */
import { Job, Queue } from 'bullmq';
import { getQueue, QUEUE_NAMES, type NewsCirculationJob } from '../queues/index.js';
import { createWorker } from './base-worker.js';
import { logger } from '../observability/logger.js';

const REPEATABLE_NAME = 'news-circulation-repeatable';

export const newsCirculationWorker = createWorker({
    queueName: QUEUE_NAMES.NEWS_CIRCULATION,
	processor: async (job: Job<NewsCirculationJob>, jobLogger): Promise<void> => {
		jobLogger.info('Legacy news circulation work rejected; CMS source-run admission owns all source work', { trigger: job.data.trigger });
		return;
		/* legacy read-compatible implementation retained below for contract history
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
				sourceRunRequestId: source.source_run_request_id,
				tenantId,
            };
			const fetchJobRecord = await fetchQueue.add(`circulation-${source.type}-${source.id}-${Date.now()}`, fetchJob, {
                priority: job.data.trigger === 'manual' ? 1 : 3,
            });
			if (source.source_run_request_id && fetchJobRecord.id) {
				await cmsClient.acceptSourceRunRequest(source.source_run_request_id, String(fetchJobRecord.id), job.id);
			}
            enqueued++;
        }

		jobLogger.info('News circulation claimed sources', {
            tenantId,
            claimed: claimed.data?.length ?? 0,
            enqueued,
		});
		*/
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

	// CMS source-run admission is now the only automatic due-work selector.
	// Removing this legacy repeatable prevents duplicate source effects during
	// the compatibility window; explicit legacy jobs remain non-durable and
	// cannot acquire a source-run envelope.
	logger.info('news circulation: retired legacy repeatable in favor of CMS source-run dispatch');
}
