/**
 * Base worker factory with retry logic and event handlers
 */
import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '../queues/redis.js';
import { config } from '../config/index.js';
import { logger, createLogger, type LogContext } from '../observability/logger.js';
import { jobsTotal, jobDuration, retryCount, dlqSize } from '../observability/metrics.js';
import { getQueue, QUEUE_NAMES, type DLQJob } from '../queues/index.js';

export interface WorkerConfig {
    queueName: string;
    concurrency?: number;
    processor: (job: Job, jobLogger: ReturnType<typeof createLogger>) => Promise<void>;
}

/**
 * Create a worker with standard event handlers and metrics
 */
export function createWorker(workerConfig: WorkerConfig): Worker {
    const { queueName, concurrency = config.workerConcurrency, processor } = workerConfig;

    const worker = new Worker(
        queueName,
        async (job: Job) => {
            const jobLogger = createLogger({
                jobId: job.id,
                queue: queueName,
            });

            const startTime = Date.now();
            jobLogger.info(`Job started`, { name: job.name, data: job.data });

            try {
                await processor(job, jobLogger);

                const durationSec = (Date.now() - startTime) / 1000;
                jobDuration.labels(queueName, job.data?.sourceType || 'unknown').observe(durationSec);

                jobLogger.info(`Job completed`, { durationMs: Date.now() - startTime });
            } catch (error) {
                jobLogger.error(`Job failed`, error);
                throw error; // Re-throw to let BullMQ handle retries
            }
        },
        {
            connection: getRedisConnection(),
            concurrency,
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
                error: error.message,
                attemptsMade,
                maxAttempts: job.opts.attempts,
            });

            // Move to DLQ if all retries exhausted
            if (job.opts.attempts && attemptsMade >= job.opts.attempts) {
                await moveToDeadLetterQueue(job, queueName, error.message);
            }
        }
    });

    worker.on('stalled', (jobId: string) => {
        jobsTotal.labels(queueName, 'stalled').inc();
        logger.warn(`Job ${jobId} stalled in queue ${queueName}`);
    });

    worker.on('error', (error: Error) => {
        logger.error(`Worker error in queue ${queueName}`, error);
    });

    worker.on('ready', () => {
        logger.info(`Worker ready for queue: ${queueName}`);
    });

    return worker;
}

/**
 * Move a failed job to the dead letter queue
 */
async function moveToDeadLetterQueue(
    job: Job,
    originalQueue: string,
    failureReason: string
): Promise<void> {
    const dlq = getQueue(QUEUE_NAMES.DLQ);
    if (!dlq) {
        logger.error('DLQ not initialized, cannot move failed job');
        return;
    }

    const dlqJob: DLQJob = {
        originalQueue,
        originalJobId: job.id || 'unknown',
        originalJobData: job.data,
        failureReason,
        failedAt: new Date().toISOString(),
        attemptsMade: job.attemptsMade,
    };

    await dlq.add('dead-letter', dlqJob);
    dlqSize.inc();

    logger.warn(`Job moved to DLQ`, {
        jobId: job.id,
        originalQueue,
        failureReason,
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
