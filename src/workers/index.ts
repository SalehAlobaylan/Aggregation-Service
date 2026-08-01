/**
 * Worker registration and management
 */
import type { Worker } from 'bullmq';
import { logger } from '../observability/logger.js';

let workers: Worker[] = [];
let startPromise: Promise<void> | null = null;

async function createWorkers(): Promise<Worker[]> {
    const [
        { fetchWorker },
        { normalizeWorker },
        { mediaWorker },
        { aiWorker },
        { atomizationWorker },
        { atomizationSweepWorker },
        { storageWorker },
        { reconcileWorker },
        { qualityWorker },
        { discoveryWorker },
        { discoverySweepWorker },
        { sourceGraphWorker },
        { newsCirculationWorker },
        { mediaCirculationWorker },
    ] = await Promise.all([
        import('./fetch.worker.js'),
        import('./normalize.worker.js'),
        import('./media.worker.js'),
        import('./ai.worker.js'),
        import('./atomization.worker.js'),
        import('./atomization-sweep.worker.js'),
        import('./storage.worker.js'),
        import('./reconcile.worker.js'),
        import('./quality.worker.js'),
        import('./discovery.worker.js'),
        import('./discovery-sweep.worker.js'),
        import('./source-graph.worker.js'),
        import('./news-circulation.worker.js'),
        import('./media-circulation.worker.js'),
    ]);

    return [
        fetchWorker,
        normalizeWorker,
        mediaWorker,
        aiWorker,
        atomizationWorker,
        atomizationSweepWorker,
        storageWorker,
        reconcileWorker,
        qualityWorker,
        discoveryWorker,
        discoverySweepWorker,
        sourceGraphWorker,
        newsCirculationWorker,
        mediaCirculationWorker,
    ];
}

/**
 * Get all registered workers.
 */
export function getAllWorkers(): Worker[] {
    return workers;
}

/**
 * Start all workers.
 */
export async function startWorkers(): Promise<void> {
    if (workers.length > 0) {
        return;
    }
    if (startPromise) {
        return startPromise;
    }

    startPromise = (async () => {
        logger.info('Starting all workers...');
        workers = await createWorkers();

        // Schedule repeatable storage sweepers (best-effort — non-fatal if CMS is down)
        syncRepeatableSweepers().catch(err => {
            logger.error('Failed to sync repeatable storage sweepers', err);
        });
        // Schedule the embedding reconciliation sweep (H2 backstop).
        syncReconcileSweeper().catch(err => {
            logger.error('Failed to sync embedding reconciliation sweeper', err);
        });
        // Schedule atomization candidate discovery for READY parents that missed
        // the original AI-worker enqueue moment.
        syncAtomizationSweeper().catch(err => {
            logger.error('Failed to sync atomization candidate sweeper', err);
        });
        // Schedule the Feeds-Finding discovery sweep (interval/toggle from CMS config).
        syncDiscoverySweeper().catch(err => {
            logger.error('Failed to sync discovery sweeper', err);
        });
        // Schedule the Source Intelligence Graph build (interval/toggle from CMS config).
        syncSourceGraphSweeper().catch(err => {
            logger.error('Failed to sync source graph sweeper', err);
        });
        // Schedule News Circulation source claims (interval from CMS policy).
        syncNewsCirculationSweeper().catch(err => {
            logger.error('Failed to sync news circulation sweeper', err);
        });
        // Schedule CMS-governed Pods source claims. Due checks and limits stay
        // in CMS; Aggregation only executes accepted handoffs.
        syncMediaCirculationSweeper().catch(err => {
            logger.error('Failed to sync media circulation sweeper', err);
        });

        const [
            { startOpMetricsFlush },
            { startCloudflareAnalyticsPuller },
        ] = await Promise.all([
            import('./op-metrics-flush.worker.js'),
            import('../services/cloudflare-analytics.service.js'),
        ]);
        // Telemetry: drain the S3 op counter to CMS hourly.
        startOpMetricsFlush();
        // Telemetry: pull Cloudflare R2 Analytics hourly (no-op if env vars unset).
        startCloudflareAnalyticsPuller();
    })();

    try {
        await startPromise;
    } finally {
        startPromise = null;
    }
}

/**
 * Close all workers gracefully.
 */
export async function closeWorkers(): Promise<void> {
    logger.info('Closing all workers...');

    const activeWorkers = workers;
    await Promise.all(
        activeWorkers.map(async (worker) => {
            try {
                await worker.close();
                logger.info(`Worker closed for queue: ${worker.name}`);
            } catch (error) {
                logger.error(`Error closing worker for queue: ${worker.name}`, error);
            }
        })
    );
    workers = [];

    logger.info('All workers closed');
}

export async function syncAtomizationSweeper(): Promise<void> {
    const mod = await import('./atomization-sweep.worker.js');
    return mod.syncAtomizationSweeper();
}

export async function syncRepeatableSweepers(): Promise<void> {
    const mod = await import('./storage.worker.js');
    return mod.syncRepeatableSweepers();
}

export async function syncReconcileSweeper(): Promise<void> {
    const mod = await import('./reconcile.worker.js');
    return mod.syncReconcileSweeper();
}

export async function syncDiscoverySweeper(): Promise<void> {
    const mod = await import('./discovery-sweep.worker.js');
    return mod.syncDiscoverySweeper();
}

export async function syncSourceGraphSweeper(): Promise<void> {
    const mod = await import('./source-graph.worker.js');
    return mod.syncSourceGraphSweeper();
}

export async function syncNewsCirculationSweeper(): Promise<void> {
    const mod = await import('./news-circulation.worker.js');
    return mod.syncNewsCirculationSweeper();
}

export async function syncMediaCirculationSweeper(): Promise<void> {
    const mod = await import('./media-circulation.worker.js');
    return mod.syncMediaCirculationSweeper();
}

export { createWorker } from './base-worker.js';
