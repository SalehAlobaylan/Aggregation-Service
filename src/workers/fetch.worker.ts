/**
 * Fetch Worker - handles content fetching from sources
 * Phase 2: Full implementation with source routing
 */
import { Job } from 'bullmq';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type FetchJob } from '../queues/index.js';
import { fetchFromSource, type SourceConfig } from '../fetchers/index.js';
import { getQueue } from '../queues/index.js';

export const fetchWorker = createWorker({
    queueName: QUEUE_NAMES.FETCH,
    processor: async (job: Job<FetchJob>, jobLogger): Promise<void> => {
        const { sourceId, sourceType, config, triggeredBy, triggeredAt } = job.data;

        jobLogger.info('Processing fetch job', {
            sourceId,
            sourceType,
            triggeredBy,
            triggeredAt,
        });

        // Build source config from job data
        const sourceConfig: SourceConfig = {
            id: sourceId,
            type: sourceType,
            name: (config.name as string) || sourceId,
            url: config.url as string,
            enabled: true,
            pollIntervalMs: (config.pollIntervalMs as number) || 300000,
            settings: (config.settings as Record<string, unknown>) || {},
        };

        // Fetch content from source
        const result = await fetchFromSource(sourceConfig, config.cursor as string | undefined);

        jobLogger.info('Fetch completed', {
            sourceId,
            sourceType,
            totalFetched: result.metadata.totalFetched,
            skipped: result.metadata.skipped,
            errors: result.metadata.errors,
            hasMore: result.hasMore,
        });

        // If we got items, enqueue normalize job
        if (result.items.length > 0) {
            const normalizeQueue = getQueue(QUEUE_NAMES.NORMALIZE);

            if (normalizeQueue) {
                await normalizeQueue.add(
                    `normalize-${sourceType}-${sourceId}-${Date.now()}`,
                    {
                        sourceId,
                        sourceType,
                        rawItems: result.items.map(item => ({
                            externalId: item.externalId,
                            rawData: item,
                            fetchedAt: item.fetchedAt,
                        })),
                        fetchJobId: job.id,
                    },
                    {
                        priority: 2,
                    }
                );

                jobLogger.info('Enqueued normalize job', {
                    sourceId,
                    sourceType,
                    itemCount: result.items.length,
                });
            }
        }

        // If there's more content to fetch, enqueue continuation job
        if (result.hasMore && result.cursor) {
            const fetchQueue = getQueue(QUEUE_NAMES.FETCH);

            if (fetchQueue) {
                await fetchQueue.add(
                    `fetch-continue-${sourceType}-${sourceId}-${Date.now()}`,
                    {
                        sourceId,
                        sourceType,
                        config: {
                            ...config,
                            cursor: result.cursor,
                        },
                        triggeredBy: 'schedule',
                        triggeredAt: new Date().toISOString(),
                    },
                    {
                        delay: 1000, // Small delay to avoid hammering source
                        priority: 3,
                    }
                );

                jobLogger.info('Enqueued continuation fetch job', {
                    sourceId,
                    sourceType,
                    cursor: result.cursor,
                });
            }
        }
    },
});
