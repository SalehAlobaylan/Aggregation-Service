import { getQueue, QUEUE_NAMES, type ContentStageClaim, type ContentStageJob } from '../queues/index.js';
import type { QueueName } from '../queues/schemas.js';
import { cmsClient } from '../cms/client.js';
import { logger } from '../observability/logger.js';

const timers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();
const CLAIMS_PER_TICK = 8;
const MAX_OUTSTANDING_PER_LANE = 16;
const MAX_OPTIONAL_OUTSTANDING = 4;

type StageName = ContentStageClaim['stage'];

function laneQueues(lane: 'news' | 'pods') {
	const names = lane === 'news'
		? [QUEUE_NAMES.NEWS_ENRICHMENT, QUEUE_NAMES.NEWS_OPTIONAL]
		: [QUEUE_NAMES.PODS_MEDIA, QUEUE_NAMES.PODS_COMPLETION, QUEUE_NAMES.PODS_OPTIONAL, QUEUE_NAMES.PODS_ATOMIZATION];
	return names.map(getQueue).filter((queue): queue is NonNullable<ReturnType<typeof getQueue>> => Boolean(queue));
}

async function outstanding(lane: 'news' | 'pods', includeOptional = false): Promise<number> {
	let total = 0;
	const optional = new Set<QueueName>(lane === 'news'
		? [QUEUE_NAMES.NEWS_OPTIONAL]
		: [QUEUE_NAMES.PODS_OPTIONAL]);
	for (const queue of laneQueues(lane).filter((candidate) => includeOptional || !optional.has(candidate.name as QueueName))) {
		const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
		total += counts.waiting + counts.active + counts.delayed + counts.prioritized;
	}
	return total;
}

export function queueNameForStage(stage: ContentStageClaim['stage']): keyof typeof QUEUE_NAMES | undefined {
	switch (stage) {
	case 'news_text_embedding': return 'NEWS_ENRICHMENT';
	case 'news_llm_metadata': return 'NEWS_OPTIONAL';
	case 'pods_media_artifacts': return 'PODS_MEDIA';
	case 'pods_text_embedding': return 'PODS_COMPLETION';
	case 'pods_caption_reembedding':
	case 'pods_llm_metadata': return 'PODS_OPTIONAL';
	case 'pods_atomization': return 'PODS_ATOMIZATION';
	default: return undefined;
	}
}

function queueFor(claim: ContentStageClaim) {
	const queueName = queueNameForStage(claim.stage);
	return queueName ? getQueue(QUEUE_NAMES[queueName]) : undefined;
}

type StageQueue = NonNullable<ReturnType<typeof getQueue>>;

/**
 * A CMS claim can outlive a dispatcher response. Re-delivery must therefore
 * replace stale queued claim data instead of relying on BullMQ's job-id
 * deduplication, which would otherwise execute an expired fence token.
 */
export async function deliverContentStageClaim(queue: StageQueue, claim: ContentStageClaim): Promise<boolean> {
	const data: ContentStageJob = { claim };
	const existing = await queue.getJob(claim.deterministic_job_id);
	if (existing) {
		const state = await existing.getState();
		if (state === 'active') {
			await cmsClient.deferContentStage(claim, 15, 'prior delivery with the same deterministic identity is still active', undefined);
			return false;
		}
		if (state === 'completed' || state === 'failed') {
			await existing.remove();
		} else {
			await existing.updateData(data);
			return true;
		}
	}
	const created = await queue.add(claim.stage, data, {
		jobId: claim.deterministic_job_id,
		attempts: 1,
		removeOnComplete: { age: 3600, count: 1000 },
		removeOnFail: { age: 86400 },
	});
	// A concurrent mixed-version dispatcher may have won the deterministic ID.
	// Ensure the durable queue contains the current fenced envelope.
	if (created.data.claim.claim_token !== claim.claim_token) await created.updateData(data);
	return true;
}

export async function dispatchContentStages(lane: 'news' | 'pods', allowedStages?: readonly StageName[]): Promise<number> {
	const dispatchKey = `${lane}:${allowedStages?.join(',') ?? 'all'}`;
	if (inFlight.has(dispatchKey)) return 0;
	inFlight.add(dispatchKey);
	let dispatched = 0;
	try {
		for (let index = 0; index < CLAIMS_PER_TICK; index += 1) {
			if (await outstanding(lane) >= MAX_OUTSTANDING_PER_LANE) break;
			const claim = await cmsClient.claimContentStage(lane, undefined, allowedStages ? [...allowedStages] : undefined);
			if (!claim) break;
			const queue = queueFor(claim);
			if (!queue) {
				await cmsClient.failContentStage(claim, 'unsupported_stage_delivery', `No static queue is registered for ${claim.stage}`);
				continue;
			}
			if (claim.stage === 'news_llm_metadata' || claim.stage === 'pods_caption_reembedding' || claim.stage === 'pods_llm_metadata') {
				if (await outstanding(lane, true) - await outstanding(lane) >= MAX_OPTIONAL_OUTSTANDING) {
					// CMS normally enforces this bound while claiming. Keep a second
					// dispatcher-side guard for mixed-version deployments, where a
					// queued claim may already exist before this process starts.
					await cmsClient.deferContentStage(claim, 30, 'optional-stage dispatch capacity is occupied', undefined);
					continue;
				}
			}
			if (!await deliverContentStageClaim(queue, claim)) continue;
			await cmsClient.contentStageAccepted(claim);
			dispatched += 1;
		}
	} catch (error) {
		logger.warn('Content-stage dispatch tick deferred', { lane, error: error instanceof Error ? error.message : 'unknown' });
	} finally {
		inFlight.delete(dispatchKey);
	}
	return dispatched;
}

export function startContentStageDispatcher(lane: 'news' | 'pods', allowedStages?: readonly StageName[]): void {
	const timerKey = `${lane}:${allowedStages?.join(',') ?? 'all'}`;
	if (timers.has(timerKey)) return;
	void dispatchContentStages(lane, allowedStages);
	const timer = setInterval(() => void dispatchContentStages(lane, allowedStages), 1000);
	timer.unref();
	timers.set(timerKey, timer);
}

export function stopContentStageDispatchers(): void {
	for (const timer of timers.values()) clearInterval(timer);
	timers.clear();
}
