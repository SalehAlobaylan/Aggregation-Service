/**
 * Quality Sweeper Worker
 *
 * One repeatable BullMQ job per enabled QualityRule. Each tick:
 *   1. Pulls a batch of candidate content items from CMS.
 *   2. Enqueues an individual QUALITY_REENCODE job per candidate.
 *
 * The repeatable schedule is (re)synced by syncRepeatableQualitySweepers(),
 * called on startup and whenever CMS pings /admin/quality/rule-changed.
 */
import type { Job, Queue } from 'bullmq';
import { createWorker } from './base-worker.js';
import {
    QUEUE_NAMES,
    type QualityReencodeJob,
    type QualitySweepJob,
} from '../queues/index.js';
import { getQueue } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { logger } from '../observability/logger.js';

const REPEATABLE_PREFIX = 'quality-sweep-auto';

export const qualitySweeperWorker = createWorker({
    queueName: QUEUE_NAMES.QUALITY_SWEEP,
    concurrency: 1,
    timeoutMs: 5 * 60 * 1000,
    processor: async (job: Job<QualitySweepJob>, jobLogger): Promise<void> => {
        const { ruleId, tenantId, trigger } = job.data;
        jobLogger.info('Quality sweep tick', { ruleId, tenantId, trigger });

        const rules = await cmsClient.listQualityRules({ enabled: true });
        const rule = rules.data.find(r => r.id === ruleId);
        if (!rule) {
            jobLogger.warn('Rule not found or no longer enabled; skipping', { ruleId });
            return;
        }

        const candidates = await cmsClient.listQualityCandidates({
            rule_id: rule.id,
            tenant_id: tenantId,
            limit: 50,
        });
        if (candidates.data.length === 0) {
            jobLogger.info('Quality sweep: no candidates for this tick', { ruleId });
            return;
        }

        const reencodeQueue = getQueue(QUEUE_NAMES.QUALITY_REENCODE) as Queue | undefined;
        if (!reencodeQueue) {
            jobLogger.error('QUALITY_REENCODE queue not initialised — cannot enqueue work');
            return;
        }

        let enqueued = 0;
        for (const c of candidates.data) {
            const payload: QualityReencodeJob = {
                contentItemId: c.content_item_id,
                targetProfileId: candidates.target_profile_id,
                tenantId,
                ruleId: rule.id,
                trigger: 'rule',
            };
            await reencodeQueue.add('reencode', payload, {
                priority: 5, // lower priority than manual jobs (default 0)
                attempts: 2,
                backoff: { type: 'exponential', delay: 30_000 },
                removeOnComplete: { age: 86400, count: 500 },
                removeOnFail: { age: 86400 },
            });
            enqueued++;
        }

        jobLogger.info('Quality sweep: candidates enqueued', { ruleId, enqueued });
    },
});

/**
 * Reconcile BullMQ's repeatable jobs against current CMS quality rules.
 * Mirror of storage.worker's syncRepeatableSweepers — same rip-and-replace
 * strategy because the rule set is small.
 */
export async function syncRepeatableQualitySweepers(): Promise<void> {
    const queue = getQueue(QUEUE_NAMES.QUALITY_SWEEP) as Queue | undefined;
    if (!queue) {
        logger.warn('quality sweeper: queue not initialized; skipping sync');
        return;
    }

    let rules;
    try {
        rules = await cmsClient.listQualityRules({ enabled: true });
    } catch (err) {
        logger.error('quality sweeper: failed to load rules from CMS', err);
        return;
    }

    const desired = new Map<
        string,
        { ruleId: number; tenantId: string; intervalMs: number }
    >();
    for (const r of rules.data) {
        const tenantId = r.tenant_id ?? 'default';
        const intervalMs = Math.max(5, r.sweep_interval_minutes) * 60 * 1000;
        desired.set(`${REPEATABLE_PREFIX}:${r.id}:${tenantId}`, {
            ruleId: r.id,
            tenantId,
            intervalMs,
        });
    }

    const existing = await queue.getRepeatableJobs();
    for (const j of existing) {
        if (j.name.startsWith(REPEATABLE_PREFIX)) {
            await queue.removeRepeatableByKey(j.key);
        }
    }

    for (const [name, { ruleId, tenantId, intervalMs }] of desired.entries()) {
        await queue.add(
            name,
            { ruleId, tenantId, trigger: 'auto' } as QualitySweepJob,
            {
                repeat: { every: intervalMs },
                removeOnComplete: { age: 86400, count: 200 },
                removeOnFail: { age: 86400 },
            }
        );
        logger.info('quality sweeper: registered repeatable sweep', {
            ruleId,
            tenantId,
            intervalMinutes: intervalMs / 60_000,
        });
    }

    if (desired.size === 0) {
        logger.info('quality sweeper: no enabled rules; auto-sweep disabled');
    }
}
