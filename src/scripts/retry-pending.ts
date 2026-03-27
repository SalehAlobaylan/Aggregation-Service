/**
 * Standalone script: enqueue media jobs for PENDING content items that were never processed.
 *
 * Run: npm run retry-pending [-- --source=TELEGRAM] [-- --limit=500]
 *
 * Unlike retry-failed (which resets FAILED→PENDING), this script targets items
 * already in PENDING status whose media jobs were never enqueued or got lost.
 * It enqueues fresh media-queue jobs without changing the status.
 *
 * Requirements:
 *  - Redis must be running (BullMQ)
 *  - CMS must be running (to list items)
 */
import 'dotenv/config';
import { Queue } from 'bullmq';
import { config } from '../config/index.js';
import { getRedisConnection } from '../queues/redis.js';
import { logger } from '../observability/logger.js';
import type { MediaJob } from '../queues/schemas.js';

const MEDIA_QUEUE_NAME = 'media-queue';

// ── Parse CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name: string) => {
    const found = args.find(a => a.startsWith(`--${name}=`));
    return found ? found.split('=')[1] : undefined;
};
const SOURCE = getArg('source')?.toUpperCase();
const LIMIT = parseInt(getArg('limit') ?? '500', 10);
const BATCH_SIZE = 100; // CMS page size per request

// ── CMS helpers ────────────────────────────────────────────────────────────────
const CMS_BASE = config.cmsBaseUrl;
const HEADERS = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.cmsServiceToken}`,
    'X-Service-Name': 'retry-pending-script',
};

interface ContentItemSummary {
    id: string;
    type: string;
    source: string;
    original_url: string;
    metadata: Record<string, unknown>;
}

async function listPending(source: string | undefined, limit: number, page: number) {
    const qs = new URLSearchParams({ status: 'PENDING', limit: String(limit), page: String(page) });
    if (source) qs.set('source', source);
    const res = await fetch(`${CMS_BASE}/content-items?${qs}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`CMS list failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{
        data: ContentItemSummary[];
        total: number;
    }>;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
    logger.info(`retry-pending: fetching PENDING items`, { source: SOURCE ?? 'ALL', limit: LIMIT });

    const redis = getRedisConnection();
    const mediaQueue = new Queue<MediaJob>(MEDIA_QUEUE_NAME, { connection: redis });

    let totalRequeued = 0;
    let totalErrors = 0;
    let page = 1;
    let remaining = LIMIT;

    while (remaining > 0) {
        const batchLimit = Math.min(remaining, BATCH_SIZE);
        const result = await listPending(SOURCE, batchLimit, page);

        if (result.data.length === 0) {
            if (page === 1) {
                logger.info('retry-pending: no PENDING items found. Exiting.');
            }
            break;
        }

        logger.info(`retry-pending: processing batch`, {
            page,
            batchSize: result.data.length,
            totalInDB: result.total,
        });

        for (const item of result.data) {
            try {
                const downloadRef = item.metadata?.telegramDownloadRef as MediaJob['downloadRef'] | undefined;
                const isPhoto = item.source === 'TELEGRAM' && item.metadata?.mediaKind === 'photo';
                const operations: MediaJob['operations'] = isPhoto
                    ? ['download']
                    : ['download', 'transcode', 'thumbnail'];

                await mediaQueue.add(
                    `retry-pending-${item.source}-${item.id}`,
                    {
                        contentItemId: item.id,
                        contentType: item.type as MediaJob['contentType'],
                        sourceType: item.source as MediaJob['sourceType'],
                        sourceUrl: item.original_url,
                        operations,
                        downloadRef,
                    },
                    { priority: 5 } // Lower priority than normal jobs (1) and retry-failed (3)
                );

                totalRequeued++;
            } catch (err) {
                totalErrors++;
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`retry-pending: failed to enqueue`, { id: item.id, error: msg });
            }
        }

        remaining -= result.data.length;

        // If this batch returned fewer items than requested, we've reached the end
        if (result.data.length < batchLimit) break;

        page++;
    }

    await mediaQueue.close();

    logger.info(`retry-pending: done`, {
        requeued: totalRequeued,
        errors: totalErrors,
        source: SOURCE ?? 'ALL',
    });

    process.exit(0);
}

main().catch(err => {
    logger.error('retry-pending: fatal error', err);
    process.exit(1);
});
