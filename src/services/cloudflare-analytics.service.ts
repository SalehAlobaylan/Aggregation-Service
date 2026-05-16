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
 * CF data lags real time by ~30 minutes. We pull yesterday + today on each
 * tick so late-arriving data backfills correctly. CMS UPSERT is additive,
 * so we MUST NOT re-pull the same window twice in a row — we track the last
 * pulled hour to avoid double-counting.
 */
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { cmsClient } from '../cms/client.js';
import type { OpMetricItem } from '../cms/types.js';

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

let timer: NodeJS.Timeout | null = null;
// Track per-date hourly windows we've already pulled, so a re-tick within the
// same hour doesn't double-count. Key: `${date}|${hour}`. In-memory only —
// on restart we re-pull the current day's data, which CMS UPSERT will simply
// add to existing counts (over-count), so we offset by a known window: only
// pull complete hours that ended >= 1h ago. See pullOnce().
const pulledHours = new Set<string>();

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
    setTimeout(() => { void pullOnce(); }, 30_000);
    timer = setInterval(() => { void pullOnce(); }, POLL_INTERVAL_MS);
    timer.unref?.();
    logger.info('Cloudflare Analytics puller: started');
}

export function stopCloudflareAnalyticsPuller(): void {
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
    const targetEnd = new Date(now.getTime() - 60 * 60 * 1000);
    const targetStart = new Date(targetEnd.getTime() - 60 * 60 * 1000);
    const dateKey = targetStart.toISOString().slice(0, 10);
    const hourKey = targetStart.toISOString().slice(0, 13);

    if (pulledHours.has(hourKey)) {
        logger.debug('Cloudflare Analytics puller: hour already pulled, skipping', { hourKey });
        return;
    }

    try {
        const items = await fetchHourlyOps(targetStart, targetEnd);
        if (items.length === 0) {
            logger.debug('Cloudflare Analytics puller: no ops for window', { hourKey });
            pulledHours.add(hourKey);
            return;
        }
        await cmsClient.writeOpMetrics({
            source: 'cloudflare',
            date: dateKey,
            items,
        });
        pulledHours.add(hourKey);
        logger.info('Cloudflare Analytics puller: flushed hour', {
            hourKey,
            rows: items.length,
        });
    } catch (err) {
        // Telemetry — non-fatal. We do NOT mark the hour as pulled, so the next
        // tick will retry. Worst case is the same hour gets double-counted if
        // the failure was actually a successful CMS write that we missed the
        // response from; we accept this for now.
        logger.warn('Cloudflare Analytics puller: pull failed (will retry next tick)', {
            err: err instanceof Error ? err.message : String(err),
            hourKey,
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
    });
    if (!resp.ok) {
        throw new Error(`Cloudflare GraphQL ${resp.status}: ${await resp.text()}`);
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
    const body = (await resp.json()) as CfResp;
    if (body.errors && body.errors.length > 0) {
        throw new Error(`Cloudflare GraphQL errors: ${body.errors.map(e => e.message).join('; ')}`);
    }
    const groups = body.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups ?? [];

    const items: OpMetricItem[] = [];
    for (const g of groups) {
        const action = g.dimensions?.actionType ?? 'OTHER';
        const count = g.sum?.requests ?? 0;
        if (count <= 0) continue;
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
function mapCfActionType(action: string): { opClass: 'A' | 'B'; opType: OpMetricItem['op_type'] } {
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
            return { opClass: 'A', opType: 'DELETE' };
        case 'DeleteObjects':
            return { opClass: 'A', opType: 'DELETE_OBJECTS' };
        case 'CreateMultipartUpload':
        case 'UploadPart':
        case 'CompleteMultipartUpload':
        case 'AbortMultipartUpload':
            return { opClass: 'A', opType: 'OTHER' };
        case 'ReadObject':
        case 'GetObject':
            return { opClass: 'B', opType: 'GET' };
        case 'HeadObject':
        case 'HeadBucket':
            return { opClass: 'B', opType: 'HEAD' };
        default:
            return { opClass: 'B', opType: 'OTHER' };
    }
}
