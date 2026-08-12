import { createHash } from 'node:crypto';

export interface SafeJobMetadata {
    contentItemId?: string;
    sourceId?: string;
    tenantId?: string;
    profileId?: string;
    sourceType?: string;
    contentType?: string;
    operations?: string[];
}

const allowedStringFields = [
    'contentItemId', 'sourceId', 'tenantId', 'profileId', 'sourceType', 'contentType',
] as const;

function safeString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    if (!normalized || normalized.length > 128) return undefined;
    return normalized;
}

// safeJobMetadata is deliberately allowlisted. Queue payloads can contain
// source settings, text, signed URLs, local paths, and provider credentials;
// none should reach operational HTTP, logs, or the DLQ.
export function safeJobMetadata(payload: unknown): SafeJobMetadata {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
    const record = payload as Record<string, unknown>;
    const out: SafeJobMetadata = {};
    for (const field of allowedStringFields) {
        const value = safeString(record[field]);
        if (value) out[field] = value;
    }
    if (Array.isArray(record.operations)) {
        const operations = record.operations
            .map(safeString)
            .filter((value): value is string => Boolean(value))
            .slice(0, 8);
        if (operations.length > 0) out.operations = operations;
    }
    return out;
}

export function safePayloadHash(payload: unknown): string {
    let serialized: string;
    try {
        serialized = JSON.stringify(payload);
    } catch {
        serialized = '[unserializable]';
    }
    return createHash('sha256').update(serialized).digest('hex');
}

export function safeFailureCode(reason: unknown): string {
    const value = reason instanceof Error ? reason.message : String(reason ?? '');
    if (/timeout|timed out|abort/i.test(value)) return 'deadline_exceeded';
    if (/unauthori[sz]ed|forbidden|\b401\b|\b403\b/i.test(value)) return 'authorization_failed';
    if (/circuit(?: breaker)?.*open/i.test(value)) return 'circuit_open';
    if (/not found/i.test(value)) return 'not_found';
    if (/rate limit|\b429\b/i.test(value)) return 'rate_limited';
    if (/\b5\d\d\b|network|connect|socket|ECONN/i.test(value)) return 'upstream_unavailable';
    return 'worker_failed';
}

export function safeFailureSummary(reason: unknown): string {
    return safeFailureCode(reason).replaceAll('_', ' ');
}

export function isDependencyDeferral(reason: unknown): boolean {
    return ['deadline_exceeded', 'upstream_unavailable', 'circuit_open', 'rate_limited'].includes(safeFailureCode(reason));
}

const sensitiveKey = /authorization|token|secret|password|cookie|session|api[_-]?key|body|settings|payload|download|mediaPath|path/i;
const urlKey = /url|uri|href/i;

// Defense in depth for structured logs. Operational identifiers remain useful,
// but request-derived URLs, source settings and nested credentials disappear.
export function redactLogData(value: unknown, key = '', depth = 0): unknown {
    if (depth > 6) return '[REDACTED_DEPTH]';
    if (sensitiveKey.test(key)) return '[REDACTED]';
    if (urlKey.test(key)) return '[REDACTED_URL]';
    if (typeof value === 'string') {
        if (/https?:\/\//i.test(value) || /bearer\s+|token=|secret=|password=/i.test(value)) return '[REDACTED]';
        return value.length > 256 ? `${value.slice(0, 256)}…` : value;
    }
    if (Array.isArray(value)) return value.slice(0, 32).map((item) => redactLogData(item, key, depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
            childKey,
            redactLogData(childValue, childKey, depth + 1),
        ]));
    }
    return value;
}
