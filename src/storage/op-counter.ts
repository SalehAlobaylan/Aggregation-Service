/**
 * S3 Operation Counter
 *
 * Wraps an S3Client with an AWS SDK middleware that increments per-(tier,
 * op_class, op_type) counters in memory. Every PUT/HEAD/GET/LIST/DELETE that
 * passes through `client.send(...)` is counted automatically — no call-site
 * changes needed.
 *
 * The hourly flush worker calls `snapshotAndReset()` to drain the in-memory
 * Map and POST it to CMS for persistence. If Aggregation crashes between
 * flushes, the in-flight bucket is lost (acceptable for telemetry).
 *
 * Class A vs Class B follows Cloudflare R2's published taxonomy (which also
 * matches AWS S3 billing classes):
 *   Class A: PUT, COPY, POST, LIST, DELETE multi (any state-mutating call
 *            and listings; the expensive class).
 *   Class B: GET, HEAD (the cheap class — but dominant at scale).
 */
import type { S3Client } from '@aws-sdk/client-s3';

export type OpClass = 'A' | 'B';
export type OpType =
    | 'PUT'
    | 'GET'
    | 'HEAD'
    | 'DELETE'
    | 'DELETE_OBJECTS'
    | 'LIST'
    | 'COPY'
    | 'OTHER';

export type StorageTierLabel = 'primary' | 'cold';

interface CounterRow {
    tier: StorageTierLabel;
    opClass: OpClass;
    opType: OpType;
    count: number;
}

// In-memory counters. Key is `${tier}|${opClass}|${opType}`.
const counters = new Map<string, number>();

/**
 * Map an AWS SDK command name to its billing class + op type. Unknown commands
 * are bucketed as 'B/OTHER' since the SDK is overwhelmingly read-shaped (a
 * misclassification here is the cheaper direction for the budget).
 */
function classify(commandName: string): { opClass: OpClass; opType: OpType } {
    switch (commandName) {
        case 'PutObjectCommand':
            return { opClass: 'A', opType: 'PUT' };
        case 'CopyObjectCommand':
            return { opClass: 'A', opType: 'COPY' };
        case 'DeleteObjectCommand':
            return { opClass: 'A', opType: 'DELETE' };
        case 'DeleteObjectsCommand':
            return { opClass: 'A', opType: 'DELETE_OBJECTS' };
        case 'ListObjectsV2Command':
        case 'ListObjectsCommand':
            return { opClass: 'A', opType: 'LIST' };
        case 'CreateMultipartUploadCommand':
        case 'UploadPartCommand':
        case 'CompleteMultipartUploadCommand':
        case 'AbortMultipartUploadCommand':
            return { opClass: 'A', opType: 'OTHER' };
        case 'HeadObjectCommand':
        case 'HeadBucketCommand':
            return { opClass: 'B', opType: 'HEAD' };
        case 'GetObjectCommand':
            return { opClass: 'B', opType: 'GET' };
        default:
            return { opClass: 'B', opType: 'OTHER' };
    }
}

/**
 * Attach the counter middleware to an S3Client. Idempotent — if a client is
 * passed twice, the middleware stack will raise (guarded by the `name`).
 */
export function attachOpCounter(client: S3Client, tier: StorageTierLabel): void {
    client.middlewareStack.add(
        (next, context) => async (args) => {
            const ctx = context as { commandName?: string };
            const cmdName = ctx.commandName ?? 'OTHER';
            const { opClass, opType } = classify(cmdName);
            const key = `${tier}|${opClass}|${opType}`;
            counters.set(key, (counters.get(key) ?? 0) + 1);
            return next(args);
        },
        { step: 'initialize', name: `op-counter-${tier}`, priority: 'high' }
    );
}

/**
 * Drain and reset the in-memory counters. Returns the deltas-since-last-call.
 * Designed to be called by the hourly flush worker.
 */
export function snapshotAndReset(): CounterRow[] {
    const out: CounterRow[] = [];
    for (const [key, count] of counters.entries()) {
        if (count <= 0) continue;
        const [tier, opClass, opType] = key.split('|') as [StorageTierLabel, OpClass, OpType];
        out.push({ tier, opClass, opType, count });
    }
    counters.clear();
    return out;
}

/**
 * Read-only peek of the current counters without resetting. Useful for
 * tests and a debug endpoint that doesn't want to perturb the flush state.
 */
export function peekCounters(): CounterRow[] {
    const out: CounterRow[] = [];
    for (const [key, count] of counters.entries()) {
        const [tier, opClass, opType] = key.split('|') as [StorageTierLabel, OpClass, OpType];
        out.push({ tier, opClass, opType, count });
    }
    return out;
}

/**
 * Test-only: clear all counters without flushing. Do NOT call from production
 * code — use snapshotAndReset() so the data hits CMS.
 */
export function _resetCountersForTest(): void {
    counters.clear();
}
