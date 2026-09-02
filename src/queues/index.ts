/**
 * BullMQ queue initialization
 */
import { Queue } from 'bullmq';
import { getRedisConnection } from './redis.js';
import { QUEUE_NAMES, type QueueName } from './schemas.js';
import { logger } from '../observability/logger.js';
import { queueDepth, dlqSize, maintenanceQueueDepth, mediaEligibleWorkAge } from '../observability/metrics.js';
import { resolveRoleTopology, type WorkerRole } from '../runtime/role-topology.js';

// Store references to all queues
const queues = new Map<QueueName, Queue>();
export type QueueRuntimeRole = WorkerRole;
let initializedRole: QueueRuntimeRole | null = null;

/**
 * Initialize all queues
 */
export function initializeQueues(role: QueueRuntimeRole = 'all'): Map<QueueName, Queue> {
    if (initializedRole) {
        if (initializedRole !== role) {
            throw new Error(`Queues already initialized for ${initializedRole}; cannot initialize ${role}`);
        }
        return queues;
    }
    const connection = getRedisConnection();
    const topology = resolveRoleTopology(role);

	for (const queueName of topology.queueClients) {
		const durableStageQueue = new Set<string>([
			QUEUE_NAMES.NEWS_ASSET,
			QUEUE_NAMES.NEWS_ENRICHMENT,
			QUEUE_NAMES.NEWS_OPTIONAL,
			QUEUE_NAMES.PODS_MEDIA,
			QUEUE_NAMES.PODS_COMPLETION,
			QUEUE_NAMES.PODS_OPTIONAL,
			QUEUE_NAMES.PODS_ATOMIZATION,
		]).has(queueName);
		const legacyAIQueue = queueName === QUEUE_NAMES.AI;
        const queue = new Queue(queueName, {
            connection,
            defaultJobOptions: {
				// CMS owns retry and uncertainty for durable normal-stage work.
				// A BullMQ delivery must therefore execute at most once.
                attempts: durableStageQueue ? 1 : 3,
                backoff: {
                    type: 'exponential',
					// Legacy AI work can outlive an Enrichment admission window.
					// A one-second retry loop turns temporary saturation into a DLQ
					// storm; durable stages defer through CMS instead.
					delay: legacyAIQueue ? 30_000 : 1000,
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

    initializedRole = role;

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

export function getInitializedQueueNames(): QueueName[] {
    return [...queues.keys()];
}

export function getInitializedQueueRole(): QueueRuntimeRole | null {
    return initializedRole;
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
    initializedRole = null;
}

// Re-export schemas
export * from './schemas.js';
