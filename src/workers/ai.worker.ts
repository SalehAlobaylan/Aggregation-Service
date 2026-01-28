/**
 * AI Worker - handles transcript and embedding generation
 * Phase 1: Stub implementation
 */
import { Job } from 'bullmq';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type AIJob } from '../queues/index.js';

export const aiWorker = createWorker({
    queueName: QUEUE_NAMES.AI,
    concurrency: 5, // AI processing with balanced concurrency
    processor: async (job: Job<AIJob>, jobLogger) => {
        const { contentItemId, contentType, operations, textContent, mediaPath } = job.data;

        jobLogger.info('Processing AI job', {
            contentItemId,
            contentType,
            operations,
            hasMediaPath: !!mediaPath,
        });

        // Phase 1: Stub - actual implementation will be added in Phase 3
        // This would:
        // 1. Generate transcript using Whisper (if mediaPath provided)
        // 2. Create transcript record in CMS
        // 3. Generate 384-dim embedding using all-MiniLM-L6-v2
        // 4. Update content item with embedding and topic tags
        // 5. Update content item status to READY

        await new Promise(resolve => setTimeout(resolve, 100));

        jobLogger.info('AI job completed (stub)', {
            contentItemId,
            operations,
        });
    },
});
