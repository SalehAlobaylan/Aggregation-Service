/**
 * Prometheus metrics for aggregation service
 * Phase 4: Enhanced metrics with consistent naming
 */
import client from 'prom-client';

// Create a Registry
export const registry = new client.Registry();

// Add default metrics (process CPU, memory, etc.)
client.collectDefaultMetrics({ register: registry });

// ============================================================================
// JOB METRICS
// ============================================================================

/**
 * Counter: Total jobs processed by queue and status
 */
export const jobsTotal = new client.Counter({
    name: 'aggregation_jobs_total',
    help: 'Total number of jobs processed',
    labelNames: ['queue', 'status'] as const,
    registers: [registry],
});

/**
 * Gauge: Current queue depth by queue name
 */
export const queueDepth = new client.Gauge({
    name: 'aggregation_queue_depth',
    help: 'Current number of jobs in queue',
    labelNames: ['queue'] as const,
    registers: [registry],
});

/**
 * Histogram: Job duration in seconds
 */
export const jobDuration = new client.Histogram({
    name: 'aggregation_job_duration_seconds',
    help: 'Job processing duration in seconds',
    labelNames: ['queue', 'source_type'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    registers: [registry],
});

/**
 * Gauge: DLQ size
 */
export const dlqSize = new client.Gauge({
    name: 'aggregation_dlq_size',
    help: 'Number of jobs in dead letter queue',
    registers: [registry],
});

/**
 * Counter: Retry attempts
 */
export const retryCount = new client.Counter({
    name: 'aggregation_retry_count',
    help: 'Number of retry attempts',
    labelNames: ['queue', 'attempt'] as const,
    registers: [registry],
});

// ============================================================================
// CIRCUIT BREAKER METRICS
// ============================================================================

/**
 * Gauge: Circuit breaker state (0 = closed, 1 = open, 2 = half-open)
 */
export const circuitState = new client.Gauge({
    name: 'aggregation_circuit_state',
    help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
    labelNames: ['dependency'] as const,
    registers: [registry],
});

/**
 * Counter: Circuit breaker trips (open events)
 */
export const circuitTrips = new client.Counter({
    name: 'aggregation_circuit_trips_total',
    help: 'Number of times circuit breaker opened',
    labelNames: ['dependency'] as const,
    registers: [registry],
});

// ============================================================================
// CMS API METRICS
// ============================================================================

/**
 * Counter: CMS API requests by endpoint and status
 */
export const cmsRequestsTotal = new client.Counter({
    name: 'aggregation_cms_requests_total',
    help: 'Total CMS API requests',
    labelNames: ['endpoint', 'status_code'] as const,
    registers: [registry],
});

/**
 * Histogram: CMS API latency
 */
export const cmsLatency = new client.Histogram({
    name: 'aggregation_cms_latency_seconds',
    help: 'CMS API request latency in seconds',
    labelNames: ['endpoint'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
});

// ============================================================================
// STORAGE METRICS
// ============================================================================

/**
 * Counter: Storage operations by type and status
 */
export const storageOpsTotal = new client.Counter({
    name: 'aggregation_storage_operations_total',
    help: 'Total storage operations',
    labelNames: ['operation', 'status'] as const,
    registers: [registry],
});

/**
 * Histogram: Storage operation latency
 */
export const storageLatency = new client.Histogram({
    name: 'aggregation_storage_latency_seconds',
    help: 'Storage operation latency in seconds',
    labelNames: ['operation'] as const,
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
});

/**
 * Counter: Bytes uploaded/downloaded
 */
export const storageBytesTotal = new client.Counter({
    name: 'aggregation_storage_bytes_total',
    help: 'Total bytes transferred to/from storage',
    labelNames: ['direction'] as const,
    registers: [registry],
});

// ============================================================================
// ERROR METRICS
// ============================================================================

/**
 * Counter: Errors by type and source
 */
export const errorsTotal = new client.Counter({
    name: 'aggregation_errors_total',
    help: 'Total errors by type',
    labelNames: ['type', 'source'] as const,
    registers: [registry],
});

// ============================================================================
// RATE LIMITER METRICS
// ============================================================================

/**
 * Counter: Rate limit hits
 */
export const rateLimitHits = new client.Counter({
    name: 'aggregation_rate_limit_hits_total',
    help: 'Number of rate limit hits',
    labelNames: ['source_type', 'source_id'] as const,
    registers: [registry],
});

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Get metrics as Prometheus text format
 */
export async function getMetrics(): Promise<string> {
    return registry.metrics();
}

/**
 * Get content type for Prometheus
 */
export function getContentType(): string {
    return registry.contentType;
}

/**
 * Record successful operation
 */
export function recordSuccess(queue: string, durationSec: number, sourceType?: string): void {
    jobsTotal.inc({ queue, status: 'success' });
    jobDuration.observe({ queue, source_type: sourceType || 'unknown' }, durationSec);
}

/**
 * Record failed operation
 */
export function recordFailure(queue: string, errorType: string): void {
    jobsTotal.inc({ queue, status: 'failed' });
    errorsTotal.inc({ type: errorType, source: queue });
}
