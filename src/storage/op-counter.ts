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
 * R2 taxonomy: A writes/listings, B reads, F free deletes/abort, U unknown.
 * These approximate SDK counts overlap provider analytics and are not bills.
 */
import type { S3Client } from '@aws-sdk/client-s3';

export type OpClass = 'A' | 'B' | 'F' | 'U';
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
 * stay unknown; no billable class or free price is inferred.
 */
function classify(commandName: string): { opClass: OpClass; opType: OpType } {
    switch (commandName) {
        case 'PutObjectCommand':
            return { opClass: 'A', opType: 'PUT' };
        case 'CopyObjectCommand':
            return { opClass: 'A', opType: 'COPY' };
        case 'DeleteObjectCommand':
            return { opClass: 'F', opType: 'DELETE' };
        case 'DeleteObjectsCommand':
            return { opClass: 'F', opType: 'DELETE_OBJECTS' };
        case 'ListObjectsV2Command':
        case 'ListObjectsCommand':
            return { opClass: 'A', opType: 'LIST' };
        case 'CreateMultipartUploadCommand':
        case 'UploadPartCommand':
        case 'CompleteMultipartUploadCommand':
            return { opClass: 'A', opType: 'OTHER' };
        case 'AbortMultipartUploadCommand':
            return { opClass: 'F', opType: 'OTHER' };
        case 'HeadObjectCommand':
        case 'HeadBucketCommand':
            return { opClass: 'B', opType: 'HEAD' };
        case 'GetObjectCommand':
            return { opClass: 'B', opType: 'GET' };
        default:
            return { opClass: 'U', opType: 'OTHER' };
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
