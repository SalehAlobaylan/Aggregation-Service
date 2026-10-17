/**
 * Cloudflare R2 Analytics Puller
 *
 * Polls the Cloudflare GraphQL Analytics API hourly for per-bucket Class A/B
 * operation counts and POSTs them to CMS as `source: 'cloudflare'` metric
 * rows. Catches the public-CDN reads that bypass our backend SDK calls — the
 * dominant ops at scale.
 *
 * Auth: a Cloudflare API token with `R2 Read` + `Analytics Read` scopes.
 *
 * The puller is fully optional. If any of CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_API_TOKEN, or CLOUDFLARE_R2_BUCKET_NAME is unset, `start...`
 * silently no-ops and the Operations panel just shows internal counts only.
 *
 * CF data lags real time. We repair up to four missing hours within a 48-hour
 * horizon plus two recent correction windows on each tick. CMS persists revision-aware replacement;
 * retries and restarts cannot add the same window twice.
 */
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { cmsClient } from '../cms/client.js';
import type { OpMetricItem } from '../cms/types.js';

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

let timer: NodeJS.Timeout | null = null;
let bootstrapTimer: NodeJS.Timeout | null = null;
// CMS persists exact-hour replacement windows; retries and restarts are safe.
export function startCloudflareAnalyticsPuller(): void {
    if (!isConfigured()) {
        logger.info('Cloudflare Analytics puller: not configured (CLOUDFLARE_* env vars missing); skipping');
        return;
    }
    if (timer) {
        logger.warn('Cloudflare Analytics puller: already running');
        return;
    }
    // Run once at boot (after a short delay to let other startup finish), then hourly.
    bootstrapTimer = setTimeout(() => {
        bootstrapTimer = null;
        void pullOnce();
    }, 30_000);
    bootstrapTimer.unref?.();
    timer = setInterval(() => { void pullOnce(); }, POLL_INTERVAL_MS);
    timer.unref?.();
    logger.info('Cloudflare Analytics puller: started');
}

export function stopCloudflareAnalyticsPuller(): void {
    if (bootstrapTimer) {
        clearTimeout(bootstrapTimer);
        bootstrapTimer = null;
    }
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

export function isConfigured(): boolean {
    return Boolean(
        config.cloudflareAccountId &&
        config.cloudflareApiToken &&
        config.cloudflareR2BucketName
    );
}

/**
 * Pull ops for the most recently completed hour. Exported for tests / debug.
 */
export async function pullOnce(): Promise<void> {
    if (!isConfigured()) return;

    // Pull the hour that ended at least 1 hour ago (CF data lag).
    const now = new Date();
    const targetEnd = new Date(Math.floor(now.getTime()/3_600_000)*3_600_000 - 3_600_000);
    const scope = `${config.cloudflareAccountId}/${config.cloudflareR2BucketName}`;
    try {
        const receiver = await cmsClient.getEconomicsCollection(scope);
        if (receiver.storage_window_version !== 1 || receiver.environment !== (process.env.WAHB_ENVIRONMENT_ID?.trim() || 'unmapped')) {
            logger.warn('Cloudflare analytics waiting for durable CMS window receiver'); return;
        }
        // At most four missing hours plus recent overlap for provider corrections.
        // Older-than-48-hour outages remain a disclosed gap, never guessed zeros.
        const recent = [1, 2].map(n => new Date(targetEnd.getTime()-n*3_600_000).toISOString());
        const starts = [...new Set([...(receiver.storage_missing_hours ?? []).slice(0, 4), ...recent])];
        for (const raw of starts) {
            const start = new Date(raw);
            if (!Number.isFinite(start.getTime()) || start.getTime()%3_600_000 !== 0 || start.getTime()>targetEnd.getTime()-3_600_000 || start.getTime()<now.getTime()-49*3_600_000) throw new Error('Invalid durable storage window');
            const end = new Date(start.getTime()+3_600_000);
            const items = await fetchHourlyOps(start, end);
            await cmsClient.writeOpMetrics({ source: 'cloudflare', tenant_id: receiver.tenant_id,
                window_start: start.toISOString(), window_end: end.toISOString(), window_key: scope,
                date: start.toISOString().slice(0,10), items });
        }
        logger.info('Cloudflare Analytics puller: committed bounded windows', { windows: starts.length });
    } catch (err) {
        logger.warn('Cloudflare Analytics puller: pull unavailable; durable missing windows retry next tick', {
            err: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Build and send the GraphQL query for a single hourly window. Maps CF's
 * `actionType` enum to our (op_class, op_type) shape.
 *
 * Response shape (simplified):
 *   r2OperationsAdaptiveGroups: [{ sum: { requests }, dimensions: { actionType } }, ...]
 */
async function fetchHourlyOps(start: Date, end: Date): Promise<OpMetricItem[]> {
    const query = `
        query R2Ops($accountTag: string!, $start: Time!, $end: Time!, $bucket: string!) {
            viewer {
                accounts(filter: { accountTag: $accountTag }) {
                    r2OperationsAdaptiveGroups(
                        limit: 100,
                        filter: { datetimeHour_geq: $start, datetimeHour_lt: $end, bucketName: $bucket }
                    ) {
                        sum { requests }
                        dimensions { actionType }
                    }
                }
            }
        }
    `;
    const variables = {
        accountTag: config.cloudflareAccountId!,
        start: start.toISOString(),
        end: end.toISOString(),
        bucket: config.cloudflareR2BucketName!,
    };
    const resp = await fetch(CF_GRAPHQL_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.cloudflareApiToken!}`,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
        throw new Error(`Cloudflare GraphQL unavailable (HTTP ${resp.status})`);
    }
    type CfResp = {
        data?: {
            viewer?: {
                accounts?: Array<{
                    r2OperationsAdaptiveGroups?: Array<{
                        sum?: { requests?: number };
                        dimensions?: { actionType?: string };
                    }>;
                }>;
            };
        };
        errors?: Array<{ message: string }>;
    };
    if (!resp.body) throw new Error('Cloudflare response body unavailable');
    const reader=resp.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
    try {
        for (;;) { const next=await reader.read(); if (next.done) break;
            bytes+=next.value.byteLength;
            if (bytes>2*1024*1024) { await reader.cancel(); throw new Error('Cloudflare response exceeds bounded window'); }
            chunks.push(next.value);
        }
    } finally { reader.releaseLock(); }
    const buffer=new Uint8Array(bytes);let offset=0;for (const chunk of chunks) {buffer.set(chunk,offset);offset+=chunk.byteLength;}
    const body = JSON.parse(new TextDecoder().decode(buffer)) as CfResp;
    if (body.errors && body.errors.length > 0) {
        throw new Error(`Cloudflare GraphQL errors: ${body.errors.map(e => e.message).join('; ')}`);
    }
    const accounts = body.data?.viewer?.accounts;
    const groups = accounts?.[0]?.r2OperationsAdaptiveGroups;
    if (!accounts || accounts.length !== 1 || !Array.isArray(groups) || groups.length >= 100) throw new Error('Cloudflare window scope or coverage unavailable');

    const items: OpMetricItem[] = [];
    for (const g of groups) {
        const action = g.dimensions?.actionType ?? 'OTHER';
        const count = g.sum?.requests;
        if (count == null || !Number.isSafeInteger(count) || count < 0 || count > 1e15) throw new Error('Invalid Cloudflare operation count');
        if (count === 0) continue;
        const mapped = mapCfActionType(action);
        items.push({ tier: 'primary', op_class: mapped.opClass, op_type: mapped.opType, count });
    }
    return items;
}

/**
 * Map CF's `actionType` enum to our (op_class, op_type). CF's enum is
 * documented at https://developers.cloudflare.com/r2/platform/metrics-analytics/
 * — values include: ListBuckets, ListObjects, WriteObject, ReadObject, etc.
 */
function mapCfActionType(action: string): { opClass: 'A' | 'B' | 'F' | 'U'; opType: OpMetricItem['op_type'] } {
    switch (action) {
        case 'ListBuckets':
        case 'ListObjects':
        case 'ListMultipartUploads':
        case 'ListParts':
            return { opClass: 'A', opType: 'LIST' };
        case 'WriteObject':
        case 'PutObject':
        case 'PutBucket':
            return { opClass: 'A', opType: 'PUT' };
        case 'CopyObject':
            return { opClass: 'A', opType: 'COPY' };
        case 'DeleteObject':
            return { opClass: 'F', opType: 'DELETE' };
        case 'DeleteObjects':
            return { opClass: 'F', opType: 'DELETE_OBJECTS' };
        case 'CreateMultipartUpload':
        case 'UploadPart':
        case 'CompleteMultipartUpload':
            return { opClass: 'A', opType: 'OTHER' };
        case 'AbortMultipartUpload':
            return { opClass: 'F', opType: 'OTHER' };
        case 'ReadObject':
        case 'GetObject':
            return { opClass: 'B', opType: 'GET' };
        case 'HeadObject':
        case 'HeadBucket':
            return { opClass: 'B', opType: 'HEAD' };
        default:
            return { opClass: 'U', opType: 'OTHER' };
    }
}
