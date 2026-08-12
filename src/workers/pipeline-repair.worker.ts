/** CMS-governed exact pipeline repair dispatcher. */
import { Job, Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { cmsClient } from '../cms/client.js';
import { getQueue, QUEUE_NAMES, type MediaJob, type PipelineRepairDispatchJob, type PipelineRepairStageJob } from '../queues/index.js';
import { createWorker } from './base-worker.js';
import { logger } from '../observability/logger.js';
import { executePipelineRepairStage } from './pipeline-repair-stage-executor.js';
import { isDependencyDeferral } from '../observability/job-projection.js';

const REPEATABLE_NAME = 'pipeline-repair-dispatch-repeatable';
const INTERVAL_MS = 5_000;

async function processClaimedStage(job: PipelineRepairStageJob, requestId?: string, signal?: AbortSignal): Promise<void> {
  // Fresh owner authorization immediately precedes the actual exact effect.
  await cmsClient.beginPipelineRepair({ repairId: job.repairId, claimToken: job.claimToken }, requestId);
  await cmsClient.heartbeatPipelineRepair({ repairId: job.repairId, claimToken: job.claimToken }, requestId);
  const result = await executePipelineRepairStage(job, signal);
  await cmsClient.completePipelineRepair({ repairId: job.repairId, claimToken: job.claimToken, producerEventId: job.producerEventId, outputDigest: result.outputDigest, output: result.output }, requestId);
}

export const pipelineRepairWorker = createWorker({
  queueName: QUEUE_NAMES.PIPELINE_REPAIR,
  concurrency: 1,
  shouldDeadLetter: (job) => 'repairId' in (job.data as PipelineRepairDispatchJob | PipelineRepairStageJob),
  shouldDeferFailure: (job, error) => !('repairId' in (job.data as PipelineRepairDispatchJob | PipelineRepairStageJob)) && isDependencyDeferral(error),
  processor: async (job: Job<PipelineRepairDispatchJob | PipelineRepairStageJob>, jobLogger, signal): Promise<void> => {
    if ('repairId' in job.data) { await processClaimedStage(job.data, job.id, signal); return; }
    const claim = await cmsClient.claimPipelineRepair(job.id);
    if (!claim) { jobLogger.debug('CMS has no exact pipeline repair to dispatch'); return; }
    const queue = getQueue(QUEUE_NAMES.PIPELINE_REPAIR);
    if (!queue) throw new Error('pipeline repair queue unavailable');
    const stage: PipelineRepairStageJob = { schemaVersion:'pipeline-repair/v1', repairId:claim.id, attemptId:claim.attemptId, claimToken:claim.claimToken, deterministicJobId:claim.deterministicJobId, stage:claim.stage, tenantId:claim.tenantId, contentItemId:claim.contentItemId, itemVersion:claim.itemVersion, sourceRunRequestId:claim.sourceRunRequestId, fenceToken:claim.fenceToken, leaseExpiresAt:claim.leaseExpiresAt, leaseEpoch:claim.leaseEpoch, effectInputDigest:claim.effectInputDigest, producerEventId:uuidv4(), content:{ type:claim.content.type, source:claim.content.source as MediaJob['sourceType'], originalUrl:claim.content.original_url ?? undefined, mediaUrl:claim.content.media_url ?? undefined, title:claim.content.title ?? undefined, excerpt:claim.content.excerpt ?? undefined, bodyText:claim.content.body_text ?? undefined, metadata:claim.content.metadata } };
    // A CMS reclaim before Begin deliberately keeps the same deterministic job
    // identity/fence. Refresh the waiting job's opaque envelope to the new
    // lease epoch instead of creating a second effect job. An in-flight old
    // envelope is rejected by CMS before it can cross the effect boundary.
    const existing = await queue.getJob(claim.deterministicJobId);
    if (existing) {
      await existing.updateData(stage);
      const state = await existing.getState();
      if (state === 'failed') await existing.retry();
      return;
    }
    await queue.add('pipeline-repair-stage', stage, { jobId: claim.deterministicJobId, priority: 1 });
  },
});

export async function syncPipelineRepairSweeper(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.PIPELINE_REPAIR) as Queue | undefined;
  if (!queue) { logger.warn('pipeline repair dispatcher: queue not initialized'); return; }
  const repeatables = await queue.getRepeatableJobs().catch(() => []);
  await Promise.all(repeatables.filter((entry) => entry.name === REPEATABLE_NAME).map((entry) => queue.removeRepeatableByKey(entry.key).catch(() => undefined)));
  await queue.add(REPEATABLE_NAME, { trigger:'auto' } satisfies PipelineRepairDispatchJob, { repeat:{every:INTERVAL_MS}, jobId:REPEATABLE_NAME, attempts: 1 });
}
