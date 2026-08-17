/**
 * Media Circulation Worker — CMS-governed Pods source pulling.
 *
 * This is deliberately separate from News Circulation: it claims only active
 * media sources, preserves source-run lineage, and lets CMS impose both the
 * source cadence and bounded intake per source. It never reads a queue as
 * evidence or decides which source is eligible.
 */
import { Job, Queue } from 'bullmq';
import { getQueue, QUEUE_NAMES, type FetchJob, type MediaCirculationJob } from '../queues/index.js';
import { createWorker } from './base-worker.js';
import { logger } from '../observability/logger.js';
import { cmsClient } from '../cms/client.js';
import { sourceAdmissionMode } from '../services/source-admission-mode.js';

const REPEATABLE_NAME = 'media-circulation-repeatable';

export const mediaCirculationWorker = createWorker({
    queueName: QUEUE_NAMES.MEDIA_CIRCULATION,
	timeoutMs: 120_000,
	processor: async (job: Job<MediaCirculationJob>, jobLogger, signal): Promise<void> => {
		const tenantId = job.data.tenantId || 'default';
		const policy = await cmsClient.getCirculationPolicy(tenantId, job.id, signal, 'media');
		const admissionMode = sourceAdmissionMode(policy);
		if (admissionMode !== 'compatibility') {
			jobLogger.info('Media circulation claim skipped: durable CMS admission owns the lane', {
				admissionMode,
				trigger: job.data.trigger,
			});
			return;
		}
        const fetchQueue = getQueue(QUEUE_NAMES.FETCH);
        if (!fetchQueue) {
            jobLogger.warn('Media circulation skipped: fetch queue unavailable');
            return;
        }

        const claimed = await cmsClient.claimMediaCirculationSources(tenantId, 0, job.id, signal);
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
                await cmsClient.acceptSourceRunRequest(source.source_run_request_id, String(fetchJobRecord.id), job.id, signal);
            }
            enqueued++;
        }

		jobLogger.info('Media circulation claimed sources', {
            tenantId,
            claimed: claimed.data?.length ?? 0,
            enqueued,
		});
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

	const policy = await cmsClient.getCirculationPolicy('default', undefined, undefined, 'media');
	const admissionMode = sourceAdmissionMode(policy);
	if (admissionMode === 'durable') {
		logger.info('media circulation: durable CMS source-run admission owns the lane');
		return;
	}

	const intervalMinutes = Math.max(1, policy.source_claim_interval_minutes || 15);
	await queue.add(
		REPEATABLE_NAME,
		{ trigger: 'auto', tenantId: 'default' } satisfies MediaCirculationJob,
		{
			repeat: { every: intervalMinutes * 60_000 },
			jobId: REPEATABLE_NAME,
		},
	);
	await queue.add(
		'media-circulation-bootstrap',
		{ trigger: 'auto', tenantId: 'default' } satisfies MediaCirculationJob,
		{ jobId: 'media-circulation-bootstrap', removeOnComplete: true, removeOnFail: true },
	);
	logger.info('media circulation: registered compatibility source claim', { intervalMinutes });
}
