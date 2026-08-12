/**
 * Media Circulation Worker — CMS-governed Pods source pulling.
 *
 * This is deliberately separate from News Circulation: it claims only active
 * media sources, preserves source-run lineage, and lets CMS impose both the
 * source cadence and bounded intake per source. It never reads a queue as
 * evidence or decides which source is eligible.
 */
import { Job, Queue } from 'bullmq';
import { getQueue, QUEUE_NAMES, type MediaCirculationJob } from '../queues/index.js';
import { createWorker } from './base-worker.js';
import { logger } from '../observability/logger.js';

const REPEATABLE_NAME = 'media-circulation-repeatable';

export const mediaCirculationWorker = createWorker({
    queueName: QUEUE_NAMES.MEDIA_CIRCULATION,
	processor: async (job: Job<MediaCirculationJob>, jobLogger): Promise<void> => {
		jobLogger.info('Legacy media circulation work rejected; CMS source-run admission owns all source work', { trigger: job.data.trigger });
		return;
		/* legacy read-compatible implementation retained below for contract history
        const tenantId = job.data.tenantId || 'default';
        const fetchQueue = getQueue(QUEUE_NAMES.FETCH);
        if (!fetchQueue) {
            jobLogger.warn('Media circulation skipped: fetch queue unavailable');
            return;
        }

        const claimed = await cmsClient.claimMediaCirculationSources(tenantId, 0, job.id);
        let enqueued = 0;
        for (const source of claimed.data ?? []) {
            const fetchJob: FetchJob = {
                sourceId: source.id,
                sourceType: source.type,
                config: {
                    name: source.name,
                    url: source.url,
                    settings: {
                        ...(source.settings ?? {}),
                        circulation: { tenantId, sourceId: source.id, lane: 'media' },
                    },
                    pollIntervalMs: source.fetch_interval_minutes * 60_000,
                },
                triggeredBy: job.data.trigger === 'manual' ? 'manual' : 'schedule',
                triggeredAt: new Date().toISOString(),
                sourceRunRequestId: source.source_run_request_id,
                tenantId,
            };
            const fetchJobRecord = await fetchQueue.add(
                `media-circulation-${source.type}-${source.id}-${Date.now()}`,
                fetchJob,
                { priority: job.data.trigger === 'manual' ? 1 : 3 },
            );
            if (source.source_run_request_id && fetchJobRecord.id) {
                await cmsClient.acceptSourceRunRequest(source.source_run_request_id, String(fetchJobRecord.id), job.id);
            }
            enqueued++;
        }

		jobLogger.info('Media circulation claimed sources', {
            tenantId,
            claimed: claimed.data?.length ?? 0,
            enqueued,
		});
		*/
	},
});

export async function syncMediaCirculationSweeper(): Promise<void> {
    const queue = getQueue(QUEUE_NAMES.MEDIA_CIRCULATION) as Queue | undefined;
    if (!queue) {
        logger.warn('media circulation: queue not initialized; skipping sync');
        return;
    }
    const repeatables = await queue.getRepeatableJobs().catch(() => []);
    await Promise.all(
        repeatables
            .filter((entry) => entry.name === REPEATABLE_NAME)
            .map((entry) => queue.removeRepeatableByKey(entry.key).catch(() => undefined)),
    );

	logger.info('media circulation: retired legacy repeatable in favor of CMS source-run dispatch');
}
