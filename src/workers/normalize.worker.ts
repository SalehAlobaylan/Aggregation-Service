/**
 * Normalize Worker - handles content normalization to canonical format
 * Phase 2: Full implementation with CMS upsert
 */
import { Job } from 'bullmq';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type NormalizeJob } from '../queues/index.js';
import { normalizeItem } from '../normalizers/index.js';
import { dedupService } from '../services/dedup.service.js';
import { upsertContentItem } from '../cms/upsert.js';
import { getQueue } from '../queues/index.js';
import type { RawFetchedItem } from '../fetchers/types.js';
import type { NormalizedItem } from '../normalizers/types.js';

interface SourceFilters {
    include_keywords?: string[];
    exclude_keywords?: string[];
    min_engagement?: number;
}

function parseSourceFilters(sourceSettings: Record<string, unknown> | undefined): SourceFilters {
    const rawFilters = (sourceSettings?.filters || {}) as Record<string, unknown>;

    const includeKeywords = Array.isArray(rawFilters.include_keywords)
        ? rawFilters.include_keywords.filter((value): value is string => typeof value === 'string')
        : [];
    const excludeKeywords = Array.isArray(rawFilters.exclude_keywords)
        ? rawFilters.exclude_keywords.filter((value): value is string => typeof value === 'string')
        : [];
    const minEngagement = typeof rawFilters.min_engagement === 'number'
        ? rawFilters.min_engagement
        : undefined;

    return {
        include_keywords: includeKeywords,
        exclude_keywords: excludeKeywords,
        min_engagement: minEngagement,
    };
}

function getItemText(normalized: NormalizedItem): string {
    return [normalized.title, normalized.excerpt || '', normalized.bodyText || '']
        .join(' ')
        .toLowerCase();
}

function getEngagementScore(rawItem: RawFetchedItem): number {
    if (!rawItem.engagement) {
        return 0;
    }

    return (
        (rawItem.engagement.likes || 0) +
        (rawItem.engagement.comments || 0) +
        (rawItem.engagement.shares || 0) +
        (rawItem.engagement.score || 0)
    );
}

function shouldSkipByFilters(
    normalized: NormalizedItem,
    rawItem: RawFetchedItem,
    filters: SourceFilters
): { skip: boolean; reason?: string } {
    const includeKeywords = filters.include_keywords || [];
    const excludeKeywords = filters.exclude_keywords || [];

    if (includeKeywords.length === 0 && excludeKeywords.length === 0 && !filters.min_engagement) {
        return { skip: false };
    }

    const itemText = getItemText(normalized);

    if (includeKeywords.length > 0) {
        const matchesInclude = includeKeywords.some((keyword) =>
            itemText.includes(keyword.toLowerCase())
        );
        if (!matchesInclude) {
            return { skip: true, reason: 'include_keywords' };
        }
    }

    if (excludeKeywords.length > 0) {
        const hasExcludedKeyword = excludeKeywords.some((keyword) =>
            itemText.includes(keyword.toLowerCase())
        );
        if (hasExcludedKeyword) {
            return { skip: true, reason: 'exclude_keywords' };
        }
    }

    if (typeof filters.min_engagement === 'number') {
        const engagementScore = getEngagementScore(rawItem);
        if (engagementScore < filters.min_engagement) {
            return { skip: true, reason: 'min_engagement' };
        }
    }

    return { skip: false };
}

export const normalizeWorker = createWorker({
    queueName: QUEUE_NAMES.NORMALIZE,
    processor: async (job: Job<NormalizeJob>, jobLogger): Promise<void> => {
        const { sourceId, sourceType, rawItems, fetchJobId, sourceSettings } = job.data;
        const sourceFilters = parseSourceFilters(sourceSettings);

        jobLogger.info('Processing normalize job', {
            sourceId,
            sourceType,
            itemCount: rawItems?.length || 0,
            fetchJobId,
        });

        let processed = 0;
        let duplicates = 0;
        let filtered = 0;
        let failed = 0;
        let mediaEnqueued = 0;
        let aiEnqueued = 0;

        for (const rawItem of rawItems || []) {
            try {
                // Cast raw data back to RawFetchedItem
                const item = rawItem.rawData as unknown as RawFetchedItem;

                // Normalize the item
                const normalized = normalizeItem(item);
                if (!normalized) {
                    failed++;
                    continue;
                }

                const filterDecision = shouldSkipByFilters(normalized, item, sourceFilters);
                if (filterDecision.skip) {
                    filtered++;
                    jobLogger.debug('Skipping item due to source filters', {
                        sourceId,
                        sourceType,
                        idempotencyKey: normalized.idempotencyKey,
                        reason: filterDecision.reason,
                    });
                    continue;
                }

                // Check for duplicates
                const dedupResult = await dedupService.checkDedup(normalized.idempotencyKey);
                if (dedupResult.isDuplicate) {
                    jobLogger.debug('Skipping duplicate', {
                        idempotencyKey: normalized.idempotencyKey,
                        existingId: dedupResult.existingId,
                    });
                    duplicates++;
                    continue;
                }

                // Upsert to CMS
                const { contentItemId, created } = await upsertContentItem(normalized, job.id);

                if (created) {
                    processed++;

                    jobLogger.info('Content item created', {
                        contentItemId,
                        idempotencyKey: normalized.idempotencyKey,
                        type: normalized.type,
                        status: normalized.status,
                    });

                    // Enqueue media jobs for VIDEO and PODCAST
                    if (normalized.type === 'VIDEO' || normalized.type === 'PODCAST') {
                        const mediaReady = Boolean((normalized.metadata as Record<string, unknown>)?.mediaReady);
                        const sourceUrl = normalized.mediaUrl || normalized.originalUrl;

                        if (mediaReady && normalized.mediaUrl) {
                            const aiQueue = getQueue(QUEUE_NAMES.AI);
                            if (aiQueue) {
                                await aiQueue.add(
                                    `ai-manual-${normalized.type}-${contentItemId}`,
                                    {
                                        contentItemId,
                                        contentType: normalized.type,
                                        operations: ['transcript', 'embedding'],
                                        textContent: {
                                            title: normalized.title,
                                            excerpt: normalized.excerpt || undefined,
                                            bodyText: normalized.bodyText || undefined,
                                        },
                                        mediaUrl: normalized.mediaUrl,
                                    },
                                    {
                                        priority: 2,
                                    }
                                );

                                aiEnqueued++;
                                jobLogger.debug('Enqueued AI job (manual media ready)', {
                                    contentItemId,
                                    type: normalized.type,
                                });
                            }
                        } else {
                            const mediaQueue = getQueue(QUEUE_NAMES.MEDIA);

                            if (mediaQueue) {
                                await mediaQueue.add(
                                    `media-${normalized.type}-${contentItemId}`,
                                    {
                                        contentItemId,
                                        contentType: normalized.type,
                                        sourceUrl,
                                        operations: ['download', 'transcode', 'thumbnail'],
                                    },
                                    {
                                        priority: normalized.type === 'VIDEO' ? 2 : 3,
                                    }
                                );

                                mediaEnqueued++;
                                jobLogger.debug('Enqueued media job', { contentItemId, type: normalized.type });
                            }
                        }
                    }
                } else {
                    duplicates++;
                }
            } catch (error) {
                failed++;
                jobLogger.error('Failed to process item', error, {
                    externalId: rawItem.externalId,
                });
            }
        }

        jobLogger.info('Normalize job completed', {
            sourceId,
            sourceType,
            processed,
            duplicates,
            filtered,
            failed,
            mediaEnqueued,
            aiEnqueued,
        });
    },
});
