/**
 * Worker registration and management
 */
import { Worker } from 'bullmq';
import { logger } from '../observability/logger.js';

// Import all workers
import { fetchWorker } from './fetch.worker.js';
import { normalizeWorker } from './normalize.worker.js';
import { mediaWorker } from './media.worker.js';
import { aiWorker } from './ai.worker.js';
import { storageWorker, syncRepeatableSweepers } from './storage.worker.js';
import { reconcileWorker, syncReconcileSweeper } from './reconcile.worker.js';
import { qualityWorker } from './quality.worker.js';
import { discoveryWorker } from './discovery.worker.js';
import { discoverySweepWorker, syncDiscoverySweeper } from './discovery-sweep.worker.js';
import { sourceGraphWorker, syncSourceGraphSweeper } from './source-graph.worker.js';
import { startOpMetricsFlush } from './op-metrics-flush.worker.js';
import { startCloudflareAnalyticsPuller } from '../services/cloudflare-analytics.service.js';

// All registered workers
const workers: Worker[] = [
    fetchWorker,
    normalizeWorker,
    mediaWorker,
    aiWorker,
    storageWorker,
    reconcileWorker,
    qualityWorker,
    discoveryWorker,
    discoverySweepWorker,
    sourceGraphWorker,
];

/**
 * Get all registered workers
 */
export function getAllWorkers(): Worker[] {
    return workers;
}

/**
 * Start all workers
 */
export function startWorkers(): void {
    logger.info('Starting all workers...');
    // Workers start automatically when created
    // Schedule repeatable storage sweepers (best-effort — non-fatal if CMS is down)
    syncRepeatableSweepers().catch(err => {
        logger.error('Failed to sync repeatable storage sweepers', err);
    });
    // Schedule the embedding reconciliation sweep (H2 backstop).
    syncReconcileSweeper().catch(err => {
        logger.error('Failed to sync embedding reconciliation sweeper', err);
    });
    // Schedule the Feeds-Finding discovery sweep (interval/toggle from CMS config).
    syncDiscoverySweeper().catch(err => {
        logger.error('Failed to sync discovery sweeper', err);
    });
    // Schedule the Source Intelligence Graph build (interval/toggle from CMS config).
    syncSourceGraphSweeper().catch(err => {
        logger.error('Failed to sync source graph sweeper', err);
    });
    // Telemetry: drain the S3 op counter to CMS hourly.
    startOpMetricsFlush();
    // Telemetry: pull Cloudflare R2 Analytics hourly (no-op if env vars unset).
    startCloudflareAnalyticsPuller();
}

/**
 * Close all workers gracefully
 */
export async function closeWorkers(): Promise<void> {
    logger.info('Closing all workers...');

    await Promise.all(
        workers.map(async (worker) => {
            try {
                await worker.close();
                logger.info(`Worker closed for queue: ${worker.name}`);
            } catch (error) {
                logger.error(`Error closing worker for queue: ${worker.name}`, error);
            }
        })
    );

    logger.info('All workers closed');
}

// Export individual workers
export { fetchWorker } from './fetch.worker.js';
export { normalizeWorker } from './normalize.worker.js';
export { mediaWorker } from './media.worker.js';
export { aiWorker } from './ai.worker.js';
export { storageWorker, syncRepeatableSweepers } from './storage.worker.js';
export { reconcileWorker, syncReconcileSweeper } from './reconcile.worker.js';
export { qualityWorker } from './quality.worker.js';
export { createWorker } from './base-worker.js';
