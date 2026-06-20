/**
 * Fetch Worker - handles content fetching from sources
 * Phase 2: Full implementation with source routing
 */
import { Job } from 'bullmq';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type FetchJob } from '../queues/index.js';
import { fetchFromSource, type SourceConfig } from '../fetchers/index.js';
import { getQueue } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';

export const fetchWorker = createWorker({
    queueName: QUEUE_NAMES.FETCH,
    processor: async (job: Job<FetchJob>, jobLogger): Promise<void> => {
        const { sourceId, sourceType, config, triggeredBy, triggeredAt } = job.data;
        const startedAt = new Date();
        const sourceSettings = (config.settings as Record<string, unknown>) || {};
        const tenantId = tenantFromSourceSettings(sourceSettings);

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
        let result: Awaited<ReturnType<typeof fetchFromSource>>;
        try {
            result = await fetchFromSource(sourceConfig, config.cursor as string | undefined);
        } catch (error) {
            await reportFetchRun(tenantId, sourceId, job.id, triggeredBy, startedAt, 0, 1, {
                sourceType,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
        await reportFetchRun(tenantId, sourceId, job.id, triggeredBy, startedAt, result.metadata.totalFetched, result.metadata.errors, {
            sourceType,
            reason: result.metadata.reason,
        });

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
                        triggeredBy,
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
                        triggeredBy,
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

function tenantFromSourceSettings(settings: Record<string, unknown>): string {
    const circulation = settings.circulation;
    if (circulation && typeof circulation === 'object' && !Array.isArray(circulation)) {
        const tenantId = (circulation as { tenantId?: unknown }).tenantId;
        if (typeof tenantId === 'string' && tenantId.trim()) {
            return tenantId.trim();
        }
    }
    return 'default';
}

async function reportFetchRun(
    tenantId: string,
    sourceId: string,
    jobId: string | undefined,
    triggeredBy: 'schedule' | 'manual',
    startedAt: Date,
    fetched: number,
    failed: number,
    metadata: Record<string, unknown>
): Promise<void> {
    if (!jobId || !isUuid(sourceId)) return;
    const finishedAt = new Date();
    try {
        await cmsClient.reportSourceRun({
            tenant_id: tenantId,
            source_id: sourceId,
            job_id: jobId,
            triggered_by: triggeredBy,
            fetched,
            failed,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
            metadata,
        }, jobId);
    } catch {
        // Telemetry must never fail ingestion.
    }
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
