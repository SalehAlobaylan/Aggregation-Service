/**
 * Source Graph Worker — scheduled automation for the Source Intelligence Graph.
 *
 * A repeatable job (scheduled by `syncSourceGraphSweeper()` from CMS config)
 * that rebuilds the citation graph + candidate ledger from your trusted sources
 * and content, then CMS auto-promotes the best candidates into review. Mirrors
 * the discovery sweeper pattern.
 */
import { Job, Queue } from 'bullmq';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type SourceGraphJob } from '../queues/index.js';
import { getQueue } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { buildSourceGraph } from '../services/intel/graph-builder.js';
import { logger } from '../observability/logger.js';

const REPEATABLE_NAME = 'source-graph-repeatable';

export const sourceGraphWorker = createWorker({
    queueName: QUEUE_NAMES.SOURCE_GRAPH,
    concurrency: 1, // graph build crawls + resolves; keep it gentle
    timeoutMs: 10 * 60_000,
    processor: async (job: Job<SourceGraphJob>, jobLogger): Promise<void> => {
        const cfg = await cmsClient.getDiscoveryConfig(job.id);
        if (!cfg.intelligence_enabled && job.data.trigger !== 'manual') {
            jobLogger.info('Source graph skipped: intelligence disabled in config');
            return;
        }
        jobLogger.info('Source graph build started');
        const result = await buildSourceGraph(cfg.recency_window_days);
        jobLogger.info('Source graph build complete', result);
    },
});

export async function syncSourceGraphSweeper(): Promise<void> {
    const queue = getQueue(QUEUE_NAMES.SOURCE_GRAPH) as Queue | undefined;
    if (!queue) {
        logger.warn('source graph: queue not initialized; skipping sync');
        return;
    }

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
        logger.warn('source graph: could not read config from CMS; not scheduling', {
            error: error instanceof Error ? error.message : String(error),
        });
        return;
    }

    if (!cfg.intelligence_enabled) {
        logger.info('source graph: intelligence disabled — no repeatable scheduled');
        return;
    }

    const intervalMs = Math.max(1, cfg.graph_build_interval_hours) * 3_600_000;
    await queue.add(
        REPEATABLE_NAME,
        { trigger: 'auto' } as SourceGraphJob,
        {
            repeat: { every: intervalMs },
            removeOnComplete: { age: 3600, count: 20 },
            removeOnFail: { age: 86400 },
        }
    );
    logger.info('source graph: registered repeatable', { intervalHours: cfg.graph_build_interval_hours });
}
