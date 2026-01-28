/**
 * Fetch Worker - handles content fetching from sources
 * Phase 1: Stub implementation
 */
import { Job } from 'bullmq';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type FetchJob } from '../queues/index.js';
import type { LogContext } from '../observability/logger.js';

export const fetchWorker = createWorker({
    queueName: QUEUE_NAMES.FETCH,
    processor: async (job: Job<FetchJob>, jobLogger) => {
        const { sourceId, sourceType, triggeredBy } = job.data;

        jobLogger.info('Processing fetch job', {
            sourceId,
            sourceType,
            triggeredBy,
        });

        // Phase 1: Stub - actual implementation will be added in Phase 2
        // This would:
        // 1. Load source configuration
        // 2. Fetch content based on source type (RSS, YouTube, etc.)
        // 3. Enqueue normalize jobs for fetched items

        // Simulate some processing time
        await new Promise(resolve => setTimeout(resolve, 100));

        jobLogger.info('Fetch job completed (stub)', {
            sourceId,
            sourceType,
        });
    },
});
