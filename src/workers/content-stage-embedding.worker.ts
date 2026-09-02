import type { Job } from 'bullmq';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type ContentStageJob } from '../queues/index.js';
import { cmsClient, contentStageCorrelation, isStaleContentStageDeliveryError } from '../cms/client.js';
import { buildEmbeddingText } from '../ai/embeddings.js';
import { EnrichmentRequestError, generateEmbeddingViaEnrichment, generateMetadataViaEnrichment } from '../ai/enrichment-client.js';
import { createLogger } from '../observability/logger.js';

async function processEmbeddingStage(expectedLane: 'news' | 'pods', allowedStages: string[], job: Job<ContentStageJob>, jobLogger: ReturnType<typeof createLogger>, signal?: AbortSignal): Promise<void> {
	const { claim } = job.data;
	if (claim.lane !== expectedLane || !allowedStages.includes(claim.stage)) {
		await cmsClient.deferContentStage(claim, 1, `Wrong-lane delivery: expected registered ${expectedLane} enrichment stage`, job.id);
		jobLogger.warn('Rejected wrong-lane content-stage delivery', { expectedLane, actualLane: claim.lane, stage: claim.stage });
		return;
	}
	const correlation = contentStageCorrelation(claim);
	let heartbeat: NodeJS.Timeout | undefined;
	let stageBegun = false;
	try {
		await cmsClient.beginContentStage(claim, job.id);
		stageBegun = true;
		heartbeat = setInterval(() => void cmsClient.heartbeatContentStage(claim, job.id).catch(() => undefined), 15_000);
		heartbeat.unref();
		const text = claim.stage === 'pods_caption_reembedding'
			? String(claim.bounded_input.caption_text ?? '')
			: buildEmbeddingText(claim.bounded_input.title ?? '', claim.bounded_input.excerpt ?? undefined, claim.bounded_input.body_text ?? undefined);
		if (!text.trim()) {
			await cmsClient.failContentStage(claim, 'invalid_input', 'No normalized text is available for embedding', job.id);
			return;
		}
		const metadataStage = claim.stage === 'news_llm_metadata' || claim.stage === 'pods_llm_metadata';
		const result = metadataStage
			? await generateMetadataViaEnrichment(text, claim.content_item_id, { requestId: job.id, contentStage: correlation, signal })
			: await generateEmbeddingViaEnrichment(text, claim.content_item_id, {
				requestId: job.id,
				extractTags: false,
				lane: claim.lane,
				contentStage: correlation,
				signal,
			});
		if (result.writeBackStatus !== 'ok' && result.writeBackStatus !== 'persisted') {
			await cmsClient.uncertainContentStage(claim, result.writeBackError ?? 'Enrichment writeback outcome is unknown', job.id);
			return;
		}
		jobLogger.info('Durable embedding effect persisted; CMS verification owns completion', { requestId: claim.request_id, lane: claim.lane });
	} catch (error) {
		if (!stageBegun && isStaleContentStageDeliveryError(error)) {
			jobLogger.info('Discarded stale or non-claimable content-stage delivery', { requestId: claim.request_id });
			return;
		}
		if (error instanceof EnrichmentRequestError && error.status === 429) {
			await cmsClient.deferContentStage(claim, error.retryAfterSeconds ?? 1, 'Enrichment lane capacity deferred', job.id);
			return;
		}
		if (error instanceof EnrichmentRequestError && error.status >= 400 && error.status < 500) {
			await cmsClient.failContentStage(claim, 'dependency_rejected_input', 'Enrichment rejected the typed embedding request', job.id);
			return;
		}
		await cmsClient.uncertainContentStage(claim, 'Embedding request may have crossed the effect boundary', job.id);
	} finally {
		if (heartbeat) clearInterval(heartbeat);
	}
}

export const createNewsEnrichmentWorker = () => createWorker({
	queueName: QUEUE_NAMES.NEWS_ENRICHMENT,
	concurrency: 1,
	processor: (job, logger, signal) => processEmbeddingStage('news', ['news_text_embedding'], job as Job<ContentStageJob>, logger, signal),
	deadLetterQueueName: QUEUE_NAMES.NEWS_STAGE_DLQ,
});

export const createNewsOptionalWorker = () => createWorker({
	queueName: QUEUE_NAMES.NEWS_OPTIONAL,
	concurrency: 1,
	processor: (job, logger, signal) => processEmbeddingStage('news', ['news_llm_metadata'], job as Job<ContentStageJob>, logger, signal),
	deadLetterQueueName: QUEUE_NAMES.NEWS_STAGE_DLQ,
});

export const createPodsCompletionWorker = () => createWorker({
	queueName: QUEUE_NAMES.PODS_COMPLETION,
	concurrency: 1,
	processor: (job, logger, signal) => processEmbeddingStage('pods', ['pods_text_embedding'], job as Job<ContentStageJob>, logger, signal),
	deadLetterQueueName: QUEUE_NAMES.PODS_STAGE_DLQ,
});

export const createPodsOptionalWorker = () => createWorker({
	queueName: QUEUE_NAMES.PODS_OPTIONAL,
	concurrency: 1,
	processor: (job, logger, signal) => processEmbeddingStage('pods', ['pods_caption_reembedding', 'pods_llm_metadata'], job as Job<ContentStageJob>, logger, signal),
	deadLetterQueueName: QUEUE_NAMES.PODS_STAGE_DLQ,
});
