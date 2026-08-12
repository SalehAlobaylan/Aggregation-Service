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
    WEBSITE: 1800000, // 30 minutes
    TELEGRAM: 1800000, // 30 minutes
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

	await unscheduleSource(config.id, config.type);
	logger.warn('Legacy per-source scheduling is disabled; CMS durable admission owns source work', { sourceId: config.id, sourceType: config.type });
	return undefined;
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
export async function triggerPoll(config: SourceConfig, lineage?: { sourceRunRequestId?: string; tenantId?: string; operatorPlanId?: string; operatorStepId?: string; idempotencyKey?: string }): Promise<string | undefined> {
	void config; void lineage;
	throw new Error('LEGACY_SOURCE_ADMISSION_DISABLED: create a CMS durable source-run request');
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
