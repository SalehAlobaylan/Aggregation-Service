import { Job, Queue } from 'bullmq';
import { cmsClient } from '../cms/client.js';
import { getQueue, QUEUE_NAMES, type SourceRunVerificationJob } from '../queues/index.js';
import { createWorker } from './base-worker.js';
import { logger } from '../observability/logger.js';
import { isDependencyDeferral } from '../observability/job-projection.js';

const REPEATABLE_NAME = 'source-run-verification-repeatable';
const VERIFICATION_INTERVAL_MS = 10_000;

// This worker has no provider client and cannot retry a source effect. CMS
// chooses one already-uncertain task, rebuilds authoritative read evidence,
// and writes the fenced reconciliation event itself.
export const createSourceRunVerificationWorker = () => createWorker({
  queueName: QUEUE_NAMES.SOURCE_RUN_VERIFICATION,
  concurrency: 1,
  shouldDeadLetter: () => false,
  shouldDeferFailure: (_job, error) => isDependencyDeferral(error),
  processor: async (job: Job<SourceRunVerificationJob>, jobLogger): Promise<void> => {
    const claim = await cmsClient.claimNextSourceRunVerification(job.id);
    if (!claim) {
      jobLogger.debug('CMS source-run verifier found no task');
      return;
    }
    const result = await cmsClient.observeSourceRunVerification({ tenantId: claim.tenant_id, taskId: claim.id, claimToken: claim.claim_token }, job.id);
    jobLogger.info('CMS source-run verification completed', { taskId: claim.id, unitId: claim.execution_unit_id, verdict: result.verdict, evidenceSnapshot: result.evidenceSnapshot });
  },
});

export async function syncSourceRunVerificationSweeper(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.SOURCE_RUN_VERIFICATION) as Queue | undefined;
  if (!queue) {
    logger.warn('source-run verification: queue not initialized; skipping sync');
    return;
  }
  const repeatables = await queue.getRepeatableJobs().catch(() => []);
  await Promise.all(repeatables.filter((entry) => entry.name === REPEATABLE_NAME).map((entry) => queue.removeRepeatableByKey(entry.key).catch(() => undefined)));
  await queue.add(REPEATABLE_NAME, { trigger: 'auto' } satisfies SourceRunVerificationJob, { repeat: { every: VERIFICATION_INTERVAL_MS }, jobId: REPEATABLE_NAME, attempts: 1 });
  logger.info('source-run verification: registered CMS evidence tick', { intervalMs: VERIFICATION_INTERVAL_MS });
}
