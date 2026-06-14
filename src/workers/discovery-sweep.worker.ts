/**
 * Discovery Sweep Worker — scheduled automation for Feeds Finding.
 *
 * A repeatable job (scheduled by `syncDiscoverySweeper()` from CMS config) that
 * fans out a `DiscoveryJob` per ENABLED discovery profile onto the DISCOVERY
 * queue, so suggestions accrue without an admin clicking Run. Interval +
 * automation toggle + tuning come from the CMS `discovery_config` table.
 *
 * Mirrors the reconcile sweeper pattern (reconcile.worker.ts).
 */
import { Job, Queue } from 'bullmq';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type DiscoveryJob, type DiscoverySweepJob } from '../queues/index.js';
import { getQueue } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { logger } from '../observability/logger.js';

const REPEATABLE_NAME = 'discovery-sweep-repeatable';

export const discoverySweepWorker = createWorker({
    queueName: QUEUE_NAMES.DISCOVERY_SWEEP,
    concurrency: 1,
    processor: async (job: Job<DiscoverySweepJob>, jobLogger): Promise<void> => {
        const cfg = await cmsClient.getDiscoveryConfig(job.id);
        if (!cfg.automation_enabled) {
            jobLogger.info('Discovery sweep skipped: automation disabled in config');
            return;
        }

        const { data: profiles } = await cmsClient.listEnabledDiscoveryProfiles(job.id);
        const discoveryQueue = getQueue(QUEUE_NAMES.DISCOVERY);
        if (!discoveryQueue) {
            jobLogger.warn('Discovery sweep: DISCOVERY queue not initialized; skipping');
            return;
        }

        // Window key dedups against a double-fire within the same interval.
        const windowKey = Math.floor(Date.now() / (Math.max(1, cfg.sweep_interval_hours) * 3_600_000));
        let enqueued = 0;
        for (const p of profiles ?? []) {
            const jobId = `sweep-${p.id}-${windowKey}`;
            const existing = await discoveryQueue.getJob(jobId);
            if (existing) {
                const state = await existing.getState();
                if (state === 'failed' || state === 'completed') {
                    await existing.remove(); // let it retry
                } else {
                    continue; // queued/active — genuine dedup
                }
            }

            const cap = cfg.max_candidates_per_profile || 15;
            const dj: DiscoveryJob = {
                profile: {
                    id: p.id,
                    name: p.name,
                    description: p.description,
                    keywords: p.keywords,
                    languages: p.languages,
                    maxSuggestionsPerRun: Math.min(p.max_suggestions_per_run ?? cap, cap),
                    recencyDays: cfg.recency_window_days,
                    searchProvider: cfg.search_provider,
                },
                triggeredBy: 'schedule',
            };
            await discoveryQueue.add(`discovery-${p.id}`, dj, {
                jobId,
                priority: 4,
                removeOnComplete: { age: 3600, count: 50 },
                removeOnFail: { age: 86400 },
            });
            enqueued++;
        }
        jobLogger.info('Discovery sweep fanned out', { enabledProfiles: (profiles ?? []).length, enqueued });
    },
});

/**
 * Register/refresh the repeatable sweep from CMS config. Called on startup and
 * whenever the admin saves discovery config (via POST /admin/discovery/resync-schedule).
 */
export async function syncDiscoverySweeper(): Promise<void> {
    const queue = getQueue(QUEUE_NAMES.DISCOVERY_SWEEP) as Queue | undefined;
    if (!queue) {
        logger.warn('discovery sweep: queue not initialized; skipping sync');
        return;
    }

    // Clear any existing repeatable(s), then re-register from current config.
    const existing = await queue.getRepeatableJobs();
    for (const j of existing) {
        if (j.name.startsWith(REPEATABLE_NAME)) {
            await queue.removeRepeatableByKey(j.key);
        }
    }

    let cfg: Awaited<ReturnType<typeof cmsClient.getDiscoveryConfig>>;
    try {
        cfg = await cmsClient.getDiscoveryConfig();
    } catch (error) {
        logger.warn('discovery sweep: could not read config from CMS; not scheduling', {
            error: error instanceof Error ? error.message : String(error),
        });
        return;
    }

    if (!cfg.automation_enabled) {
        logger.info('discovery sweep: automation disabled — no repeatable scheduled');
        return;
    }

    const intervalMs = Math.max(1, cfg.sweep_interval_hours) * 3_600_000;
    await queue.add(
        REPEATABLE_NAME,
        { trigger: 'auto' } as DiscoverySweepJob,
        {
            repeat: { every: intervalMs },
            removeOnComplete: { age: 3600, count: 20 },
            removeOnFail: { age: 86400 },
        }
    );
    logger.info('discovery sweep: registered repeatable', { intervalHours: cfg.sweep_interval_hours });
}
