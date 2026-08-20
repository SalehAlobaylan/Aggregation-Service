/**
 * Worker registration and management
 */
import type { Worker } from 'bullmq';
import { logger } from '../observability/logger.js';

let workers: Worker[] = [];
let startPromise: Promise<void> | null = null;
export type WorkerRole = 'all' | 'intake-control' | 'news' | 'pods';

async function createWorkers(role: WorkerRole): Promise<Worker[]> {
	if (role === 'news') {
		const { createNewsEnrichmentWorker, createNewsOptionalWorker } = await import('./content-stage-embedding.worker.js');
		return [createNewsEnrichmentWorker(), createNewsOptionalWorker()];
	}
	if (role === 'pods') {
		const [{ createPodsCompletionWorker, createPodsOptionalWorker }, { createPodsMediaWorker }, { podsAtomizationStageWorker }] = await Promise.all([
			import('./content-stage-embedding.worker.js'),
			import('./media.worker.js'),
			import('./content-stage-atomization.worker.js'),
		]);
		return [createPodsMediaWorker(), createPodsCompletionWorker(), createPodsOptionalWorker(), podsAtomizationStageWorker];
	}
    const [
        { fetchWorker },
        { normalizeWorker },
		{ createLegacyMediaWorker },
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
		{ sourceRunDispatchWorker },
		{ sourceRunVerificationWorker },
		{ lifecycleReceiptWorker },
		{ pipelineRepairWorker },
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
		import('./source-run-dispatch.worker.js'),
		import('./source-run-verification.worker.js'),
		import('./lifecycle-receipt.worker.js'),
		import('./pipeline-repair.worker.js'),
    ]);

	const intakeWorkers = [
        fetchWorker,
        normalizeWorker,
		createLegacyMediaWorker(),
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
		sourceRunDispatchWorker,
		sourceRunVerificationWorker,
		lifecycleReceiptWorker,
		pipelineRepairWorker,
    ];
	if (role === 'intake-control') return intakeWorkers;
	const [{ createNewsEnrichmentWorker, createNewsOptionalWorker, createPodsCompletionWorker, createPodsOptionalWorker }, { createPodsMediaWorker }, { podsAtomizationStageWorker }] = await Promise.all([
		import('./content-stage-embedding.worker.js'),
		import('./media.worker.js'),
		import('./content-stage-atomization.worker.js'),
	]);
	return [...intakeWorkers, createNewsEnrichmentWorker(), createNewsOptionalWorker(), createPodsMediaWorker(), createPodsCompletionWorker(), createPodsOptionalWorker(), podsAtomizationStageWorker];
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
export async function startWorkers(role: WorkerRole = 'all'): Promise<void> {
    if (workers.length > 0) {
        return;
    }
    if (startPromise) {
        return startPromise;
    }

    startPromise = (async () => {
        logger.info('Starting worker role', { role });
        workers = await createWorkers(role);
		if (role === 'news' || role === 'pods') return;
		const { startContentStageDispatcher } = await import('../services/content-stage-dispatcher.js');
		startContentStageDispatcher('news');
		startContentStageDispatcher('pods');

        // Jobs queued before the media priority split would otherwise remain
        // buried behind the existing News embedding backlog after a restart.
        import('../services/ai-queue-priority.js')
            .then(async ({ reprioritizePendingMediaAIJobs }) => {
                const repaired = await reprioritizePendingMediaAIJobs();
                if (repaired > 0) {
                    logger.info('Reprioritized pending media AI jobs', { count: repaired });
                }
            })
            .catch(err => logger.error('Failed to repair pending media AI priorities', err));

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
		// CMS owns due selection and authorization. This timer only requests one
		// bounded claim; it has no source or tenant selection authority.
		syncSourceRunDispatchSweeper().catch(err => {
			logger.error('Failed to sync CMS source-run dispatcher', err);
		});
		syncSourceRunVerificationSweeper().catch(err => {
			logger.error('Failed to sync CMS source-run verification', err);
		});
		syncLifecycleReceiptActionSweeper().catch(err => {
			logger.error('Failed to sync Supply receipt recovery', err);
		});
		syncPipelineRepairSweeper().catch(err => {
			logger.error('Failed to sync CMS pipeline repair dispatcher', err);
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

    // BullMQ's close waits for active processors, but the dev watcher force-kills
    // the role after five seconds. Abort first so downloads and FFmpeg children
    // receive their cooperative signal and cannot survive as orphan processes.
    const { abortActiveProcessors } = await import('./base-worker.js');
	const { stopContentStageDispatchers } = await import('../services/content-stage-dispatcher.js');
	stopContentStageDispatchers();
    const aborted = abortActiveProcessors();
    if (aborted > 0) {
        logger.info('Aborted active processors for shutdown', { count: aborted });
    }

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

export async function syncSourceRunDispatchSweeper(): Promise<void> {
	const mod = await import('./source-run-dispatch.worker.js');
	return mod.syncSourceRunDispatchSweeper();
}

export async function syncSourceRunVerificationSweeper(): Promise<void> {
	const mod = await import('./source-run-verification.worker.js');
	return mod.syncSourceRunVerificationSweeper();
}

export async function syncLifecycleReceiptActionSweeper(): Promise<void> {
	const mod = await import('./lifecycle-receipt.worker.js');
	return mod.syncLifecycleReceiptActionSweeper();
}

export async function syncPipelineRepairSweeper(): Promise<void> {
	const mod = await import('./pipeline-repair.worker.js');
	return mod.syncPipelineRepairSweeper();
}

export { createWorker } from './base-worker.js';
