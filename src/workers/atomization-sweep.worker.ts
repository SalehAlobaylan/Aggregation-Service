/** CMS-governed exact-parent atomization dispatcher.
 *
 * This worker has no tenant, source, filter, or candidate-selection input. It
 * can only claim one immutable request selected and fenced by CMS, then adopt
 * its deterministic atomization job identity.
 */
import { Job, Queue } from 'bullmq';
import { cmsClient } from '../cms/client.js';
import { getQueue, QUEUE_NAMES, type AtomizationJob, type AtomizationSweepJob } from '../queues/index.js';
import { logger } from '../observability/logger.js';
import { createWorker } from './base-worker.js';
import { isDependencyDeferral } from '../observability/job-projection.js';

const REPEATABLE_NAME = 'atomization-cms-claim-repeatable';
const INTERVAL_MS = 10_000;

export const atomizationSweepWorker = createWorker({
  queueName: QUEUE_NAMES.ATOMIZATION_SWEEP,
  concurrency: 1,
  shouldDeadLetter: () => false,
  shouldDeferFailure: (_job, error) => isDependencyDeferral(error),
  processor: async (job: Job<AtomizationSweepJob>, jobLogger): Promise<void> => {
    const claim = await cmsClient.claimAtomizationWork(job.id);
    if (!claim) { jobLogger.debug('CMS has no atomization work to dispatch'); return; }
    const queue = getQueue(QUEUE_NAMES.ATOMIZATION);
    if (!queue) throw new Error('atomization queue unavailable');
    const work: AtomizationJob = {
      contentItemId: claim.parentContentItemId,
      reason: 'sweeper',
      workRequestId: claim.id,
      workAttemptId: claim.attemptId,
      workClaimToken: claim.claimToken,
      workFenceToken: claim.fenceToken,
      workInputFingerprint: claim.inputFingerprint,
    };
    await queue.add('atomize-cms-request', work, { jobId: claim.deterministicJobId, priority: 1, attempts: 1 });
  },
});

export async function syncAtomizationSweeper(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.ATOMIZATION_SWEEP) as Queue | undefined;
  if (!queue) { logger.warn('atomization dispatcher: queue not initialized'); return; }
  const repeatables = await queue.getRepeatableJobs().catch(() => []);
  await Promise.all(repeatables.map((entry) => queue.removeRepeatableByKey(entry.key).catch(() => undefined)));
  await queue.add(REPEATABLE_NAME, { trigger: 'auto' }, { repeat: { every: INTERVAL_MS }, jobId: REPEATABLE_NAME, attempts: 1 });
}
