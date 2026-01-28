/**
 * BullMQ queue initialization
 */
import { Queue } from 'bullmq';
import { getRedisConnection } from './redis.js';
import { QUEUE_NAMES, type QueueName } from './schemas.js';
import { logger } from '../observability/logger.js';
import { queueDepth, dlqSize } from '../observability/metrics.js';

// Store references to all queues
const queues = new Map<QueueName, Queue>();

/**
 * Initialize all queues
 */
export function initializeQueues(): Map<QueueName, Queue> {
    const connection = getRedisConnection();

    // Create each queue
    for (const [key, queueName] of Object.entries(QUEUE_NAMES)) {
        const queue = new Queue(queueName, {
            connection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 1000,
                },
                removeOnComplete: {
                    age: 3600, // Keep completed jobs for 1 hour
                    count: 1000, // Keep last 1000 completed jobs
                },
                removeOnFail: {
                    age: 86400, // Keep failed jobs for 24 hours
                },
            },
        });

        queues.set(queueName as QueueName, queue);
        logger.info(`Queue initialized: ${queueName}`);
    }

    return queues;
}

/**
 * Get a specific queue
 */
export function getQueue(name: QueueName): Queue | undefined {
    return queues.get(name);
}

/**
 * Get all queues
 */
export function getAllQueues(): Map<QueueName, Queue> {
    return queues;
}

/**
 * Update queue depth metrics for all queues
 */
export async function updateQueueMetrics(): Promise<void> {
    for (const [queueName, queue] of queues.entries()) {
        try {
            const waiting = await queue.getWaitingCount();
            const active = await queue.getActiveCount();
            const delayed = await queue.getDelayedCount();

            const totalDepth = waiting + active + delayed;
            queueDepth.labels(queueName).set(totalDepth);

            // Update DLQ size separately
            if (queueName === QUEUE_NAMES.DLQ) {
                dlqSize.set(totalDepth);
            }
        } catch (error) {
            logger.error(`Failed to get queue metrics for ${queueName}`, error);
        }
    }
}

/**
 * Close all queues
 */
export async function closeQueues(): Promise<void> {
    for (const [name, queue] of queues.entries()) {
        await queue.close();
        logger.info(`Queue closed: ${name}`);
    }
    queues.clear();
}

// Re-export schemas
export * from './schemas.js';
