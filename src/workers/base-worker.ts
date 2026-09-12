/**
 * Base worker factory with retry logic and event handlers
 */
import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '../queues/redis.js';
import { config } from '../config/index.js';
import { logger, createLogger, type LogContext } from '../observability/logger.js';
import { jobsTotal, jobDuration, retryCount, dlqSize } from '../observability/metrics.js';
import { getQueue, QUEUE_NAMES, type DLQJob } from '../queues/index.js';
import { safeFailureCode, safeFailureSummary, safeJobMetadata, safePayloadHash } from '../observability/job-projection.js';
import { registerWorkerLiveness } from './worker-liveness.js';

export interface WorkerConfig {
    queueName: string;
    concurrency?: number;
    timeoutMs?: number;
    /**
     * BullMQ's delivery lock is separate from the CMS durable lease.  Long
     * media effects must get a longer lock window so a transient Redis
     * renewal failure cannot requeue a still-running process.  The processor
     * remains responsible for aborting when the lock is actually lost.
     */
    lockDurationMs?: number;
    lockRenewTimeMs?: number;
    maxStalledCount?: number;
    processor: (job: Job, jobLogger: ReturnType<typeof createLogger>, signal?: AbortSignal) => Promise<void>;
    /**
     * Control ticks are disposable scheduler wakeups, not durable operational
     * units. Their CMS-owned work remains recoverable from its ledger and the
     * next tick, so copying an exhausted tick into the DLQ only creates noise.
     */
    shouldDeadLetter?: (job: Job) => boolean;
    /** A control tick may safely wait for its next schedule when no durable
     * effect was claimed and a dependency is temporarily unavailable. */
    shouldDeferFailure?: (job: Job, error: unknown) => boolean;
	/** Durable domain stages have independent exception queues so one lane's
	 * incident cannot hide the other lane's failures. */
	deadLetterQueueName?: string;
}

/**
 * Create a worker with standard event handlers and metrics
 */
export function createWorker(workerConfig: WorkerConfig): Worker {
    const {
        queueName,
        concurrency = config.workerConcurrency,
        timeoutMs = config.defaultJobTimeoutMs,
        lockDurationMs,
        lockRenewTimeMs,
        maxStalledCount = config.maxStalledCount,
        processor,
        shouldDeadLetter = () => true,
        shouldDeferFailure = () => false,
		deadLetterQueueName = QUEUE_NAMES.DLQ,
    } = workerConfig;

    const worker = new Worker(
        queueName,
        async (job: Job, _token?: string, signal?: AbortSignal) => {
            const jobLogger = createLogger({
                jobId: job.id,
                queue: queueName,
            });

            const startTime = Date.now();
            jobLogger.info(`Job started`, { name: job.name, ...safeJobMetadata(job.data) });

            try {
                await runProcessorWithTimeout(processor, job, jobLogger, {
                    timeoutMs,
                    queueName,
                    jobId: job.id,
                    signal,
                });

                const durationSec = (Date.now() - startTime) / 1000;
                jobDuration.labels(queueName, job.data?.sourceType || 'unknown').observe(durationSec);

                jobLogger.info(`Job completed`, { durationMs: Date.now() - startTime });
            } catch (error) {
                if (shouldDeferFailure(job, error)) {
                    jobLogger.warn('Control tick deferred', { failureCode: safeFailureCode(error) });
                    return;
                }
                jobLogger.error(`Job failed`, error);
                throw error; // Re-throw to let BullMQ handle retries
            }
        },
        {
            connection: getRedisConnection(),
            concurrency,
            // Keep the historic short lock for ordinary stages.  Long media
            // workers opt into a bounded workload-aware window below.
            ...(lockDurationMs !== undefined ? { lockDuration: lockDurationMs } : {}),
            ...(lockRenewTimeMs !== undefined ? { lockRenewTime: lockRenewTimeMs } : {}),
            stalledInterval: config.stalledIntervalMs,
            maxStalledCount,
            // Role startup validates the complete worker cohort before any
            // BullMQ blocking connection is allowed to consume work.
            autorun: false,
        }
    );

    // Event handlers
    worker.on('completed', (job: Job) => {
        jobsTotal.labels(queueName, 'completed').inc();
        logger.debug(`Job ${job.id} completed in queue ${queueName}`);
    });

    worker.on('failed', async (job: Job | undefined, error: Error) => {
        jobsTotal.labels(queueName, 'failed').inc();

        if (job) {
            const attemptsMade = job.attemptsMade;
            retryCount.labels(queueName, String(attemptsMade)).inc();

            logger.warn(`Job ${job.id} failed in queue ${queueName}`, {
                failureCode: safeFailureCode(error),
                attemptsMade,
                maxAttempts: job.opts.attempts,
            });

            // Move to DLQ if all retries exhausted
            if (job.opts.attempts && attemptsMade >= job.opts.attempts && shouldDeadLetter(job)) {
                await moveToDeadLetterQueue(job, queueName, error.message, deadLetterQueueName);
            }
        }
    });

    worker.on('stalled', (jobId: string) => {
        jobsTotal.labels(queueName, 'stalled').inc();
        logger.warn(`Job ${jobId} stalled in queue ${queueName}`, {
            stalledIntervalMs: config.stalledIntervalMs,
            maxStalledCount: config.maxStalledCount,
            note: 'Job will be automatically failed and moved to DLQ after maxStalledCount is reached',
        });
    });

    // BullMQ reports a failed renewal but otherwise leaves the processor
    // running.  That is unsafe for media effects: the job is moved back to
    // `wait` after the lock expires while ffmpeg/upload can still mutate
    // storage.  Cancel the processor immediately so its AbortSignal tears
    // down child processes and the durable CMS attempt can reconcile before
    // another delivery starts.
    worker.on('lockRenewalFailed', (jobIds: string[]) => {
        for (const jobId of jobIds) {
            const cancelled = worker.cancelJob(
                jobId,
                `BullMQ delivery lock renewal failed for ${queueName}`,
            );
            logger.warn('BullMQ delivery lock renewal failed; processor cancelled', {
                queue: queueName,
                jobId,
                cancelled,
                lockDurationMs: lockDurationMs ?? 30_000,
                lockRenewTimeMs: lockRenewTimeMs ?? (lockDurationMs ?? 30_000) / 2,
            });
        }
    });

    worker.on('error', (error: Error) => {
        logger.error(`Worker error in queue ${queueName}`, error);
    });

    worker.on('ready', () => {
        logger.info(`Worker ready for queue: ${queueName}`);
    });

    registerWorkerLiveness(worker);

    return worker;
}

interface ProcessorTimeoutOptions {
    signal?: AbortSignal;
    timeoutMs: number;
    queueName: string;
    jobId?: string;
    cancellationGraceMs?: number;
}

const DEFAULT_CANCELLATION_GRACE_MS = 5_000;
const activeProcessorControllers = new Set<AbortController>();

export function abortActiveProcessors(
    reason: Error = new Error('Aggregation worker shutdown requested'),
): number {
    const controllers = [...activeProcessorControllers];
    for (const controller of controllers) {
        controller.abort(reason);
    }
    return controllers.length;
}

// Deliberately indirect only for the child-process test. Production uses an
// immediate role exit: returning a failed BullMQ promise while the processor
// still runs would permit a duplicate retry in this process.
let terminateNonCooperativeRole: (code: number) => never = (code) => process.exit(code);

function jobTimeoutError(timeoutMs: number, queueName: string, jobId?: string): Error {
    return new Error(`Job timed out after ${timeoutMs}ms in queue ${queueName} (jobId: ${jobId ?? 'unknown'})`);
}

/**
 * Run a processor with a cooperative timeout signal. The timeout aborts work,
 * but the job is not failed/completed until the processor actually returns.
 */
export async function runProcessorWithTimeout(
    processor: WorkerConfig['processor'],
    job: Job,
    jobLogger: ReturnType<typeof createLogger>,
    options: ProcessorTimeoutOptions
): Promise<void> {
    const controller = new AbortController();
    activeProcessorControllers.add(controller);
    const timeoutError = jobTimeoutError(options.timeoutMs, options.queueName, options.jobId);
    const cancellationGraceMs = options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS;
    let timeoutWake: (() => void) | undefined;
    const timeout = new Promise<'timed_out'>((resolve) => {
        timeoutWake = () => resolve('timed_out');
    });
    const onAbort = () => timeoutWake?.();
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const onOwnershipLost = () => controller.abort(options.signal?.reason ?? new Error('Queue ownership lost'));
    options.signal?.addEventListener('abort', onOwnershipLost, { once: true });
    if (options.signal?.aborted) onOwnershipLost();
    const timer = setTimeout(() => {
        controller.abort(timeoutError);
        timeoutWake?.();
    }, options.timeoutMs);
    timer.unref();

    try {
        controller.signal.throwIfAborted();
        const operation = processor(job, jobLogger, controller.signal);
        const outcome = await Promise.race([
            operation.then(
                () => ({ kind: 'completed' as const }),
                (error: unknown) => ({ kind: 'failed' as const, error }),
            ),
            timeout,
        ]);
        if (outcome === 'timed_out') {
            const afterAbort = await Promise.race([
                operation.then(
                    () => ({ kind: 'completed' as const }),
                    (error: unknown) => ({ kind: 'failed' as const, error }),
                ),
                new Promise<'grace_expired'>((resolve) => setTimeout(() => resolve('grace_expired'), cancellationGraceMs)),
            ]);
            if (afterAbort === 'grace_expired') {
                jobLogger.error('Processor ignored cancellation; terminating worker role', controller.signal.reason, {
                    cancellationGraceMs,
                    queueName: options.queueName,
                });
                terminateNonCooperativeRole(1);
            }
            if (afterAbort.kind === 'failed') {
                throw afterAbort.error;
            }
            // Even a cooperative processor that resolved after its deadline
            // cannot report a successful timed-out job.
            throw controller.signal.reason;
        }
        if (outcome.kind === 'failed') {
            throw outcome.error;
        }
        controller.signal.throwIfAborted();
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onOwnershipLost);
        controller.signal.removeEventListener('abort', onAbort);
        activeProcessorControllers.delete(controller);
    }
}

export const workerTestUtils = {
    setRoleTerminator(terminator: (code: number) => never): () => void {
        const previous = terminateNonCooperativeRole;
        terminateNonCooperativeRole = terminator;
        return () => {
            terminateNonCooperativeRole = previous;
        };
    },
};

/**
 * Move a failed job to the dead letter queue
 */
async function moveToDeadLetterQueue(
    job: Job,
    originalQueue: string,
    failureReason: string,
	dlqName: string,
): Promise<void> {
    const dlq = getQueue(dlqName as Parameters<typeof getQueue>[0]);
    if (!dlq) {
        logger.error('DLQ not initialized, cannot move failed job');
        return;
    }

	const dlqJob: DLQJob = {
		originalQueue,
		originalJobId: job.id || 'unknown',
		metadata: safeJobMetadata(job.data),
		payloadHash: safePayloadHash(job.data),
		schemaVersion: 1,
		failureCode: safeFailureCode(failureReason),
		failureSummary: safeFailureSummary(failureReason),
        failedAt: new Date().toISOString(),
        attemptsMade: job.attemptsMade,
    };

    await dlq.add('dead-letter', dlqJob);
    dlqSize.inc();

    logger.warn(`Job moved to DLQ`, {
        jobId: job.id,
        originalQueue,
        failureCode: dlqJob.failureCode,
    });
}

/**
 * Retry logic configuration
 */
export const defaultRetryConfig = {
    attempts: 3,
    backoff: {
        type: 'exponential' as const,
        delay: 1000, // 1s, 2s, 4s
    },
};

/**
 * Extended retry config for external API calls
 */
export const apiRetryConfig = {
    attempts: 5,
    backoff: {
        type: 'exponential' as const,
        delay: 2000, // 2s, 4s, 8s, 16s, 32s
    },
};
