/**
 * Scheduler Service
 * Manages BullMQ repeatable jobs for source polling
 */
import { getQueue, QUEUE_NAMES } from '../queues/index.js';
import { logger } from '../observability/logger.js';
import type { SourceType } from '../queues/schemas.js';
import type { SourceConfig } from '../fetchers/types.js';

// Default polling intervals per source type (in milliseconds)
const DEFAULT_POLL_INTERVALS: Record<SourceType, number> = {
    RSS: 900000,      // 15 minutes
    YOUTUBE: 3600000, // 1 hour (conserve quota)
    PODCAST: 3600000, // 1 hour
    PODCAST_DISCOVERY: 86400000, // 24 hours (discovery is slower cadence)
    REDDIT: 600000,   // 10 minutes
    TWITTER: 1800000, // 30 minutes
    UPLOAD: 0,        // Never poll (manual only)
    MANUAL: 0,        // Never poll
};

/**
 * Register a source for scheduled polling
 */
export async function scheduleSource(config: SourceConfig): Promise<string | undefined> {
    if (!config.enabled) {
        logger.debug('Source disabled, skipping schedule', { sourceId: config.id });
        return undefined;
    }

    const interval = config.pollIntervalMs || DEFAULT_POLL_INTERVALS[config.type];

    if (!interval || interval === 0) {
        logger.debug('No polling interval for source type', {
            sourceId: config.id,
            sourceType: config.type
        });
        return undefined;
    }

    const fetchQueue = getQueue(QUEUE_NAMES.FETCH);
    if (!fetchQueue) {
        logger.error('Fetch queue not initialized');
        return undefined;
    }

    const jobName = `scheduled-${config.type}-${config.id}`;

    // Remove existing schedule if any
    await unscheduleSource(config.id, config.type);

    // Add repeatable job
    const job = await fetchQueue.add(
        jobName,
        {
            sourceId: config.id,
            sourceType: config.type,
            config: {
                name: config.name,
                url: config.url,
                settings: config.settings,
            },
            triggeredBy: 'schedule',
            triggeredAt: new Date().toISOString(),
        },
        {
            repeat: {
                every: interval,
            },
            jobId: jobName,
            removeOnComplete: 10,
            removeOnFail: 20,
        }
    );

    logger.info('Source scheduled for polling', {
        sourceId: config.id,
        sourceType: config.type,
        intervalMs: interval,
        jobId: job.id,
    });

    return job.id ?? undefined;
}

/**
 * Remove a source from scheduled polling
 */
export async function unscheduleSource(sourceId: string, sourceType: SourceType): Promise<boolean> {
    const fetchQueue = getQueue(QUEUE_NAMES.FETCH);
    if (!fetchQueue) {
        return false;
    }

    const jobName = `scheduled-${sourceType}-${sourceId}`;

    // Remove the repeatable job
    const removed = await fetchQueue.removeRepeatable(jobName, {
        every: DEFAULT_POLL_INTERVALS[sourceType]
    });

    if (removed) {
        logger.info('Source unscheduled', { sourceId, sourceType });
    }

    return removed;
}

/**
 * Trigger an immediate poll for a source
 */
export async function triggerPoll(config: SourceConfig): Promise<string | undefined> {
    const fetchQueue = getQueue(QUEUE_NAMES.FETCH);
    if (!fetchQueue) {
        logger.error('Fetch queue not initialized');
        return undefined;
    }

    const jobName = `manual-${config.type}-${config.id}-${Date.now()}`;

    const job = await fetchQueue.add(
        jobName,
        {
            sourceId: config.id,
            sourceType: config.type,
            config: {
                name: config.name,
                url: config.url,
                settings: config.settings,
            },
            triggeredBy: 'manual',
            triggeredAt: new Date().toISOString(),
        },
        {
            priority: 1, // High priority for manual triggers
        }
    );

    logger.info('Manual poll triggered', {
        sourceId: config.id,
        sourceType: config.type,
        jobId: job.id,
    });

    return job.id ?? undefined;
}

/**
 * Get all scheduled jobs
 */
export async function getScheduledJobs(): Promise<{ name: string; interval: number }[]> {
    const fetchQueue = getQueue(QUEUE_NAMES.FETCH);
    if (!fetchQueue) {
        return [];
    }

    const repeatableJobs = await fetchQueue.getRepeatableJobs();

    return repeatableJobs.map(job => ({
        name: job.name,
        interval: typeof job.every === 'number' ? job.every : 0,
    }));
}

export const scheduler = {
    scheduleSource,
    unscheduleSource,
    triggerPoll,
    getScheduledJobs,
    DEFAULT_POLL_INTERVALS,
};
