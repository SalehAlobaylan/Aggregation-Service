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
        const sourceSettings = (config.settings as Record<string, unknown>) || {};

        const configuredMaxResults = getPositiveInteger(
            sourceSettings.max_results,
            sourceSettings.maxResults
        );

        const fetchedSoFar = getPositiveInteger(config.fetchedSoFar, 0) || 0;

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

        const remainingAllowed =
            typeof configuredMaxResults === 'number' && configuredMaxResults > 0
                ? Math.max(configuredMaxResults - fetchedSoFar, 0)
                : undefined;

        const itemsForThisRun =
            typeof remainingAllowed === 'number'
                ? result.items.slice(0, remainingAllowed)
                : result.items;

        const droppedByConfiguredCap = result.items.length - itemsForThisRun.length;
        if (droppedByConfiguredCap > 0) {
            jobLogger.info('Trimmed fetched items to respect configured max_results', {
                sourceId,
                sourceType,
                fetchedSoFar,
                configuredMaxResults,
                dropped: droppedByConfiguredCap,
            });
        }

        jobLogger.info('Fetch completed', {
            sourceId,
            sourceType,
            totalFetched: result.metadata.totalFetched,
            acceptedForRun: itemsForThisRun.length,
            skipped: result.metadata.skipped,
            errors: result.metadata.errors,
            hasMore: result.hasMore,
        });

        const totalFetchedSoFar = fetchedSoFar + itemsForThisRun.length;
        const reachedMaxResults =
            typeof configuredMaxResults === 'number' && configuredMaxResults > 0
                ? totalFetchedSoFar >= configuredMaxResults
                : false;

        // If we got items, enqueue normalize job
        if (itemsForThisRun.length > 0) {
            const normalizeQueue = getQueue(QUEUE_NAMES.NORMALIZE);

            if (normalizeQueue) {
                await normalizeQueue.add(
                    `normalize-${sourceType}-${sourceId}-${Date.now()}`,
                    {
                        sourceId,
                        sourceType,
                        rawItems: itemsForThisRun.map(item => ({
                            externalId: item.externalId,
                            rawData: item,
                            fetchedAt: item.fetchedAt,
                        })),
                        fetchJobId: job.id,
                        sourceSettings: sourceConfig.settings,
                    },
                    {
                        priority: 2,
                    }
                );

                jobLogger.info('Enqueued normalize job', {
                    sourceId,
                    sourceType,
                    itemCount: itemsForThisRun.length,
                });
            }
        }

        // If there's more content to fetch, enqueue continuation job
        if (result.hasMore && result.cursor && !reachedMaxResults) {
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
                            fetchedSoFar: totalFetchedSoFar,
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
                    fetchedSoFar: totalFetchedSoFar,
                    configuredMaxResults,
                });
            }
        } else if (reachedMaxResults) {
            jobLogger.info('Reached configured max_results, stopping pagination', {
                sourceId,
                sourceType,
                fetchedSoFar: totalFetchedSoFar,
                configuredMaxResults,
            });
        }
    },
});

function getPositiveInteger(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return Math.floor(value);
        }
    }
    return undefined;
}
