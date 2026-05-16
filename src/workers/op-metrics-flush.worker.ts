/**
 * Op-Metrics Flush Worker
 *
 * Drains the in-memory S3 op counters every hour and POSTs them to CMS for
 * persistence into `storage_op_metrics`. Lightweight — uses `setInterval`
 * rather than BullMQ because:
 *   - The work is purely telemetry; losing one hour's bucket on crash is fine.
 *   - We don't want retries clogging a queue if CMS is briefly unavailable.
 *   - It's per-process, not per-tenant — one timer per Aggregation replica.
 *
 * Also flushes once on SIGTERM so graceful shutdowns don't drop the
 * unflushed bucket.
 */
import { snapshotAndReset } from '../storage/op-counter.js';
import { cmsClient } from '../cms/client.js';
import { logger } from '../observability/logger.js';

const FLUSH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let timer: NodeJS.Timeout | null = null;
let shutdownHookInstalled = false;

export function startOpMetricsFlush(): void {
    if (timer) {
        logger.warn('op-metrics flush: already running, ignoring second start');
        return;
    }
    timer = setInterval(() => {
        void flushOnce();
    }, FLUSH_INTERVAL_MS);
    // Don't keep the event loop alive for the timer — let other Node lifecycle
    // logic decide when to exit.
    timer.unref?.();

    if (!shutdownHookInstalled) {
        shutdownHookInstalled = true;
        process.once('SIGTERM', () => { void flushOnce(); });
        process.once('SIGINT', () => { void flushOnce(); });
    }
    logger.info(`op-metrics flush: started (interval ${FLUSH_INTERVAL_MS / 60_000} min)`);
}

export function stopOpMetricsFlush(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

/**
 * Flush whatever is in the in-memory counter map to CMS.
 * Exported so it can be triggered manually from a debug endpoint or test.
 */
export async function flushOnce(): Promise<void> {
    const items = snapshotAndReset();
    if (items.length === 0) return;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    try {
        const resp = await cmsClient.writeOpMetrics({
            source: 'internal',
            date: today,
            items: items.map(i => ({
                tier: i.tier,
                op_class: i.opClass,
                op_type: i.opType,
                count: i.count,
            })),
        });
        logger.info('op-metrics: flushed to CMS', { rows: items.length, written: resp.written });
    } catch (err) {
        // Telemetry is non-transactional. A failed flush drops this hour's
        // counter values — acceptable. We do NOT re-add them to the map
        // because the snapshot already reset them, and re-adding could
        // double-count if a retry succeeds out of order.
        logger.warn('op-metrics: flush failed (counter values lost for this hour)', {
            err: err instanceof Error ? err.message : String(err),
            droppedRows: items.length,
        });
    }
}
