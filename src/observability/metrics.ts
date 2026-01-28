/**
 * Prometheus metrics for aggregation service
 */
import client from 'prom-client';

// Create a Registry
export const registry = new client.Registry();

// Add default metrics (process CPU, memory, etc.)
client.collectDefaultMetrics({ register: registry });

// Custom metrics

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
 * Gauge: Circuit breaker state (0 = closed, 1 = open, 2 = half-open)
 */
export const circuitState = new client.Gauge({
    name: 'aggregation_circuit_state',
    help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
    labelNames: ['dependency'] as const,
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

// Helper to get metrics as Prometheus text format
export async function getMetrics(): Promise<string> {
    return registry.metrics();
}

// Helper to get content type
export function getContentType(): string {
    return registry.contentType;
}
