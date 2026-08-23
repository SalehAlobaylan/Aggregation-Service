/**
 * BullMQ queue initialization
 */
import { Queue } from 'bullmq';
import { getRedisConnection } from './redis.js';
import { QUEUE_NAMES, type QueueName } from './schemas.js';
import { logger } from '../observability/logger.js';
import { queueDepth, dlqSize, maintenanceQueueDepth, mediaEligibleWorkAge } from '../observability/metrics.js';

// Store references to all queues
const queues = new Map<QueueName, Queue>();
export type QueueRuntimeRole = 'all' | 'intake-control' | 'news' | 'pods-control' | 'media-executor' | 'media-maintenance';

const ROLE_QUEUES: Record<QueueRuntimeRole, readonly QueueName[]> = {
    all: Object.values(QUEUE_NAMES),
    'intake-control': [
        QUEUE_NAMES.FETCH, QUEUE_NAMES.NORMALIZE, QUEUE_NAMES.AI,
        QUEUE_NAMES.ATOMIZATION_SWEEP, QUEUE_NAMES.DISCOVERY,
        QUEUE_NAMES.DISCOVERY_SWEEP, QUEUE_NAMES.SOURCE_GRAPH,
        QUEUE_NAMES.NEWS_CIRCULATION, QUEUE_NAMES.MEDIA_CIRCULATION,
        QUEUE_NAMES.SOURCE_RUN_DISPATCH, QUEUE_NAMES.SOURCE_RUN_VERIFICATION,
        QUEUE_NAMES.LIFECYCLE_RECEIPTS, QUEUE_NAMES.DLQ,
    ],
    news: [QUEUE_NAMES.NEWS_ENRICHMENT, QUEUE_NAMES.NEWS_OPTIONAL, QUEUE_NAMES.NEWS_STAGE_DLQ],
    'pods-control': [QUEUE_NAMES.PODS_COMPLETION, QUEUE_NAMES.PODS_OPTIONAL, QUEUE_NAMES.PODS_ATOMIZATION, QUEUE_NAMES.PODS_STAGE_DLQ],
    'media-executor': [QUEUE_NAMES.MEDIA, QUEUE_NAMES.PODS_MEDIA, QUEUE_NAMES.ATOMIZATION, QUEUE_NAMES.AI, QUEUE_NAMES.PODS_STAGE_DLQ, QUEUE_NAMES.DLQ],
    'media-maintenance': [QUEUE_NAMES.STORAGE_SWEEP, QUEUE_NAMES.RECONCILE, QUEUE_NAMES.QUALITY_REENCODE, QUEUE_NAMES.PIPELINE_REPAIR, QUEUE_NAMES.DLQ],
};

/**
 * Initialize all queues
 */
export function initializeQueues(role: QueueRuntimeRole = 'all'): Map<QueueName, Queue> {
    const connection = getRedisConnection();

	for (const queueName of ROLE_QUEUES[role]) {
		const durableStageQueue = new Set<string>([
			QUEUE_NAMES.NEWS_ASSET,
			QUEUE_NAMES.NEWS_ENRICHMENT,
			QUEUE_NAMES.NEWS_OPTIONAL,
			QUEUE_NAMES.PODS_MEDIA,
			QUEUE_NAMES.PODS_COMPLETION,
			QUEUE_NAMES.PODS_OPTIONAL,
			QUEUE_NAMES.PODS_ATOMIZATION,
		]).has(queueName);
        const queue = new Queue(queueName, {
            connection,
            defaultJobOptions: {
				// CMS owns retry and uncertainty for durable normal-stage work.
				// A BullMQ delivery must therefore execute at most once.
                attempts: durableStageQueue ? 1 : 3,
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

        queues.set(queueName, queue);
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
    const mediaQueues = new Set<QueueName>([QUEUE_NAMES.MEDIA, QUEUE_NAMES.PODS_MEDIA, QUEUE_NAMES.ATOMIZATION]);
    const maintenanceQueues = new Set<QueueName>([QUEUE_NAMES.STORAGE_SWEEP, QUEUE_NAMES.RECONCILE, QUEUE_NAMES.QUALITY_REENCODE, QUEUE_NAMES.PIPELINE_REPAIR]);
    let oldestMediaQueuedAt = 0;
    let maintenanceDepth = 0;
    for (const [queueName, queue] of queues.entries()) {
        try {
            const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
            const totalDepth = counts.waiting + counts.active + counts.delayed + counts.prioritized;
            queueDepth.labels(queueName).set(totalDepth);

            if (maintenanceQueues.has(queueName)) maintenanceDepth += totalDepth;
            if (mediaQueues.has(queueName) && totalDepth > 0) {
                const [oldest] = await queue.getJobs(['waiting', 'prioritized', 'delayed'], 0, 0, false);
                if (oldest?.timestamp) {
                    oldestMediaQueuedAt = oldestMediaQueuedAt === 0
                        ? oldest.timestamp
                        : Math.min(oldestMediaQueuedAt, oldest.timestamp);
                }
            }

            // Update DLQ size separately
            if (queueName === QUEUE_NAMES.DLQ) {
                dlqSize.set(totalDepth);
            }
        } catch (error) {
            logger.error(`Failed to get queue metrics for ${queueName}`, error);
        }
    }
    maintenanceQueueDepth.set(maintenanceDepth);
    mediaEligibleWorkAge.set(oldestMediaQueuedAt === 0 ? 0 : Math.max(0, (Date.now() - oldestMediaQueuedAt) / 1000));
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
