/**
 * Storage Sweep Worker
 *
 * Each job represents one circulation cycle for a single tenant.
 * Runs S3 deletions + CMS archival via the storage service.
 *
 * Repeatable jobs are scheduled by `syncRepeatableSweepers()` based on the
 * policies CMS exposes via /internal/storage/policies. The orchestrator calls
 * that whenever the platform console flips a policy.
 */
import { Job, Queue } from 'bullmq';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type StorageSweepJob } from '../queues/index.js';
import { getQueue } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { runSweepForTenant } from '../services/storage.service.js';
import { logger } from '../observability/logger.js';
import type { StoragePolicy } from '../cms/types.js';

export const storageWorker = createWorker({
    queueName: QUEUE_NAMES.STORAGE_SWEEP,
    concurrency: 1,
    timeoutMs: 10 * 60 * 1000, // 10 min
    processor: async (job: Job<StorageSweepJob>, jobLogger): Promise<void> => {
        const { tenantId, trigger } = job.data;
        jobLogger.info('Storage sweep tick', { tenantId, trigger });

        const policies = await cmsClient.listStoragePolicies();
        const policy =
            policies.all.find(p => p.tenant_id === tenantId) ??
            policies.global ??
            null;

        if (!policy) {
            jobLogger.warn('No policy found for tenant; skipping', { tenantId });
            return;
        }

        // Tenant-id from job overrides whatever the policy says (policy may be the global default)
        const effectivePolicy: StoragePolicy = { ...policy, tenant_id: tenantId };
        const result = await runSweepForTenant(effectivePolicy, trigger);

        jobLogger.info('Sweep tick complete', {
            tenantId,
            deleted: result.deletedCount,
            freed: result.freedBytes,
            skipped: result.skipped,
            reason: result.reason,
            error: result.error,
        });
    },
});

const REPEATABLE_PREFIX = 'storage-sweep-auto';

/**
 * Reconcile BullMQ's repeatable jobs against current CMS policies.
 * Call this on startup and after any policy change.
 */
export async function syncRepeatableSweepers(): Promise<void> {
    const queue = getQueue(QUEUE_NAMES.STORAGE_SWEEP) as Queue | undefined;
    if (!queue) {
        logger.warn('storage worker: queue not initialized; skipping sync');
        return;
    }

    let policies;
    try {
        policies = await cmsClient.listStoragePolicies();
    } catch (err) {
        logger.error('storage worker: failed to load policies from CMS', err);
        return;
    }

    // Build the desired set: every policy with enabled=true gets one repeatable
    // job keyed by `{prefix}:{tenant_id}` and an interval matching the policy.
    const desired = new Map<string, { tenantId: string; intervalMs: number }>();
    for (const p of policies.all) {
        if (!p.enabled) continue;
        const tenantId = p.tenant_id ?? 'default';
        const intervalMs = Math.max(1, p.sweep_interval_minutes) * 60 * 1000;
        desired.set(`${REPEATABLE_PREFIX}:${tenantId}`, { tenantId, intervalMs });
    }

    // Drop everything we currently have and re-register from scratch — simpler
    // than diffing, and the queue is small.
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
        if (job.name.startsWith(REPEATABLE_PREFIX)) {
            await queue.removeRepeatableByKey(job.key);
        }
    }

    for (const [name, { tenantId, intervalMs }] of desired.entries()) {
        await queue.add(
            name,
            { tenantId, trigger: 'auto' } as StorageSweepJob,
            {
                repeat: { every: intervalMs },
                removeOnComplete: { age: 86400, count: 200 },
                removeOnFail: { age: 86400 },
            }
        );
        logger.info('storage worker: registered repeatable sweep', {
            tenantId,
            intervalMinutes: intervalMs / 60_000,
        });
    }

    if (desired.size === 0) {
        logger.info('storage worker: no enabled policies; auto-sweep disabled');
    }
}
