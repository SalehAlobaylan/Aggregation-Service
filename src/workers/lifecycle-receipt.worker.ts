import { Job, Queue } from 'bullmq';
import { cmsClient } from '../cms/client.js';
import { getQueue, QUEUE_NAMES, type LifecycleReceiptActionJob, type LifecycleReceiptJob } from '../queues/index.js';
import { createWorker } from './base-worker.js';
import { sourceRunReceiptSchema } from '../contracts/source-runs.js';
import { isDependencyDeferral } from '../observability/job-projection.js';

// Delivery is intentionally a separate worker. A source executor may only
// finish after this retained job has obtained CMS acknowledgement; retries
// replay the identical event key and exact payload digest.
export const createLifecycleReceiptWorker = () => createWorker({
  queueName: QUEUE_NAMES.LIFECYCLE_RECEIPTS,
  shouldDeadLetter: (job) => !('trigger' in (job.data as LifecycleReceiptJob | LifecycleReceiptActionJob)),
  shouldDeferFailure: (job, error) => 'trigger' in (job.data as LifecycleReceiptJob | LifecycleReceiptActionJob) && isDependencyDeferral(error),
  processor: async (job: Job<LifecycleReceiptJob | LifecycleReceiptActionJob>): Promise<void> => {
		if ('trigger' in job.data) {
			const action = await cmsClient.claimReceiptRedeliveryAction(job.id)
			if (!action) return
			await cmsClient.prepareReceiptRedeliveryAction({ actionId: action.id, claimToken: action.claimToken }, job.id)
			await cmsClient.completeReceiptRedeliveryAction({ actionId: action.id, claimToken: action.claimToken }, job.id)
			return
		}
    const receipt = sourceRunReceiptSchema.parse(job.data.receipt);
		await cmsClient.retainSourceRunReceipt(receipt, job.id);
    await cmsClient.deliverSourceRunReceipt(receipt, job.id);
		await cmsClient.markSourceRunReceiptDelivered(receipt, job.id);
  },
});

const RECEIPT_ACTION_SWEEPER = 'supply-receipt-redelivery-repeatable';
export async function syncLifecycleReceiptActionSweeper(): Promise<void> {
	const queue = getQueue(QUEUE_NAMES.LIFECYCLE_RECEIPTS) as Queue | undefined;
	if (!queue) return;
	const repeatables = await queue.getRepeatableJobs().catch(() => []);
	await Promise.all(repeatables.filter((entry) => entry.name === RECEIPT_ACTION_SWEEPER).map((entry) => queue.removeRepeatableByKey(entry.key).catch(() => undefined)));
	await queue.add(RECEIPT_ACTION_SWEEPER, { trigger: 'auto' } satisfies LifecycleReceiptActionJob, { repeat: { every: 5_000 }, jobId: RECEIPT_ACTION_SWEEPER, attempts: 1 });
}
