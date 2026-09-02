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
import { sourceAdmissionMode } from '../services/source-admission-mode.js';

const REPEATABLE_NAME = 'news-circulation-repeatable';

export const createNewsCirculationWorker = () => createWorker({
    queueName: QUEUE_NAMES.NEWS_CIRCULATION,
	timeoutMs: 120_000,
	processor: async (job: Job<NewsCirculationJob>, jobLogger, signal): Promise<void> => {
		const policy = await cmsClient.getCirculationPolicy(job.data.tenantId || 'default', job.id, signal);
		const admissionMode = sourceAdmissionMode(policy);
		if (admissionMode !== 'compatibility') {
			jobLogger.info('News circulation claim skipped: durable CMS admission owns the lane', {
				admissionMode,
				trigger: job.data.trigger,
			});
			return;
		}
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
		const claimed = await cmsClient.claimCirculationSources(tenantId, claimLimit, force, job.id, recovery, signal);

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
				await cmsClient.acceptSourceRunRequest(source.source_run_request_id, String(fetchJobRecord.id), job.id, signal);
			}
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

    const policy = await cmsClient.getCirculationPolicy('default');
	const admissionMode = sourceAdmissionMode(policy);
	if (admissionMode === 'durable') {
		const repeatables = await queue.getRepeatableJobs();
		await Promise.all(repeatables.filter((entry) => entry.name === REPEATABLE_NAME).map((entry) => queue.removeRepeatableByKey(entry.key)));
		logger.info('news circulation: durable CMS source-run admission owns the lane');
		return;
	}

	const intervalMinutes = Math.max(1, policy.source_claim_interval_minutes || 15);
	const every = intervalMinutes * 60_000;
	await queue.add(
		REPEATABLE_NAME,
		{ trigger: 'auto', tenantId: 'default' } satisfies NewsCirculationJob,
		{
			repeat: { every },
			jobId: REPEATABLE_NAME,
		}
	);
	const installed = await queue.getRepeatableJobs();
	await Promise.all(installed
		.filter((entry) => entry.name === REPEATABLE_NAME && Number(entry.every) !== every)
		.map((entry) => queue.removeRepeatableByKey(entry.key)));
	logger.info('news circulation: registered compatibility source claim', { intervalMinutes });
}
