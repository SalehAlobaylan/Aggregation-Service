import { getQueue, QUEUE_NAMES, type ContentStageClaim, type ContentStageJob } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { logger } from '../observability/logger.js';

const timers = new Map<'news' | 'pods', NodeJS.Timeout>();
const inFlight = new Set<'news' | 'pods'>();
const CLAIMS_PER_TICK = 8;
const MAX_OUTSTANDING_PER_LANE = 16;

function laneQueues(lane: 'news' | 'pods') {
	const names = lane === 'news'
		? [QUEUE_NAMES.NEWS_ENRICHMENT, QUEUE_NAMES.NEWS_ASSET]
		: [QUEUE_NAMES.PODS_MEDIA, QUEUE_NAMES.PODS_COMPLETION, QUEUE_NAMES.PODS_ATOMIZATION];
	return names.map(getQueue).filter((queue): queue is NonNullable<ReturnType<typeof getQueue>> => Boolean(queue));
}

async function outstanding(lane: 'news' | 'pods'): Promise<number> {
	let total = 0;
	for (const queue of laneQueues(lane)) {
		const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
		total += counts.waiting + counts.active + counts.delayed + counts.prioritized;
	}
	return total;
}

function queueFor(claim: ContentStageClaim) {
	switch (claim.stage) {
	case 'news_text_embedding':
	case 'news_llm_metadata': return getQueue(QUEUE_NAMES.NEWS_OPTIONAL);
	case 'pods_media_artifacts': return getQueue(QUEUE_NAMES.PODS_MEDIA);
	case 'pods_text_embedding':
	case 'pods_caption_reembedding':
	case 'pods_llm_metadata': return getQueue(QUEUE_NAMES.PODS_OPTIONAL);
	case 'pods_atomization': return getQueue(QUEUE_NAMES.PODS_ATOMIZATION);
	default: return undefined;
	}
}

export async function dispatchContentStages(lane: 'news' | 'pods'): Promise<number> {
	if (inFlight.has(lane)) return 0;
	inFlight.add(lane);
	let dispatched = 0;
	try {
		for (let index = 0; index < CLAIMS_PER_TICK; index += 1) {
			if (await outstanding(lane) >= MAX_OUTSTANDING_PER_LANE) break;
			const claim = await cmsClient.claimContentStage(lane);
			if (!claim) break;
			const queue = queueFor(claim);
			if (!queue) {
				await cmsClient.failContentStage(claim, 'unsupported_stage_delivery', `No static queue is registered for ${claim.stage}`);
				continue;
			}
			const data: ContentStageJob = { claim };
			await queue.add(claim.stage, data, {
				jobId: claim.deterministic_job_id,
				attempts: 1,
				removeOnComplete: { age: 3600, count: 1000 },
				removeOnFail: { age: 86400 },
			});
			await cmsClient.contentStageAccepted(claim);
			dispatched += 1;
		}
	} catch (error) {
		logger.warn('Content-stage dispatch tick deferred', { lane, error: error instanceof Error ? error.message : 'unknown' });
	} finally {
		inFlight.delete(lane);
	}
	return dispatched;
}

export function startContentStageDispatcher(lane: 'news' | 'pods'): void {
	if (timers.has(lane)) return;
	void dispatchContentStages(lane);
	const timer = setInterval(() => void dispatchContentStages(lane), 1000);
	timer.unref();
	timers.set(lane, timer);
}

export function stopContentStageDispatchers(): void {
	for (const timer of timers.values()) clearInterval(timer);
	timers.clear();
}
