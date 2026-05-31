/**
 * Standalone script: reset FAILED content items to PENDING and re-enqueue media jobs.
 *
 * Run: npm run retry-failed [-- --source=TELEGRAM] [-- --limit=200]
 *
 * Requirements:
 *  - Redis must be running (BullMQ)
 *  - CMS must be running (to list + reset items)
 *
 * No Aggregation Service HTTP server needed.
 */
import 'dotenv/config';
import { Queue } from 'bullmq';
import { config } from '../config/index.js';
import { getRedisConnection } from '../queues/redis.js';
import { logger } from '../observability/logger.js';
import type { AIJob, MediaJob } from '../queues/schemas.js';
import { enqueueRetryJob } from '../queues/retry-routing.js';

const MEDIA_QUEUE_NAME = 'media-queue';
const AI_QUEUE_NAME = 'ai-queue';

// ── Parse CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name: string) => {
    const found = args.find(a => a.startsWith(`--${name}=`));
    return found ? found.split('=')[1] : undefined;
};
const SOURCE = getArg('source')?.toUpperCase() ?? 'TELEGRAM';
const LIMIT = parseInt(getArg('limit') ?? '500', 10);

// ── CMS helpers ────────────────────────────────────────────────────────────────
const CMS_BASE = config.cmsBaseUrl; // e.g. http://localhost:8080/internal
const HEADERS = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.cmsServiceToken}`,
    'X-Service-Name': 'retry-failed-script',
};

async function listFailed(source: string, limit: number) {
    const qs = new URLSearchParams({ status: 'FAILED', source, limit: String(limit) });
    const res = await fetch(`${CMS_BASE}/content-items?${qs}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`CMS list failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{
        data: Array<{
            id: string;
            type: string;
            source: string;
            original_url: string;
            metadata: Record<string, unknown>;
        }>;
        total: number;
    }>;
}

async function resetToPending(id: string) {
    const res = await fetch(`${CMS_BASE}/content-items/${id}/status`, {
        method: 'PATCH',
        headers: HEADERS,
        body: JSON.stringify({ status: 'PENDING', failure_reason: '' }),
    });
    if (!res.ok) throw new Error(`CMS status reset failed: ${res.status}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
    logger.info(`retry-failed: fetching FAILED items`, { source: SOURCE, limit: LIMIT });

    const result = await listFailed(SOURCE, LIMIT);
    logger.info(`retry-failed: found ${result.data.length} FAILED items (total in DB: ${result.total})`);

    if (result.data.length === 0) {
        logger.info('Nothing to retry. Exiting.');
        process.exit(0);
    }

    const redis = getRedisConnection();
    const mediaQueue = new Queue<MediaJob>(MEDIA_QUEUE_NAME, { connection: redis });
    const aiQueue = new Queue<AIJob>(AI_QUEUE_NAME, { connection: redis });

    let requeued = 0;
    const errors: string[] = [];

    for (const item of result.data) {
        try {
            await resetToPending(item.id);

            // Routes Telegram text posts to embedding instead of the media queue.
            const route = await enqueueRetryJob(
                { media: mediaQueue, ai: aiQueue },
                item,
                { namePrefix: 'retry-media', priority: 3 },
            );

            requeued++;
            logger.info(`retry-failed: ✓ requeued`, { id: item.id, source: item.source, route });
        } catch (err) {
            const msg = `${item.id}: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            logger.warn(`retry-failed: ✗ skipped`, { id: item.id, error: msg });
        }
    }

    await mediaQueue.close();

    logger.info(`retry-failed: done`, { requeued, errors: errors.length, total: result.total });
    if (errors.length) {
        logger.warn('retry-failed: errors', { errors });
    }

    process.exit(0);
}

main().catch(err => {
    logger.error('retry-failed: fatal error', err);
    process.exit(1);
});
