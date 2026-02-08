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

export const normalizeWorker = createWorker({
    queueName: QUEUE_NAMES.NORMALIZE,
    processor: async (job: Job<NormalizeJob>, jobLogger): Promise<void> => {
        const { sourceId, sourceType, rawItems, fetchJobId } = job.data;

        jobLogger.info('Processing normalize job', {
            sourceId,
            sourceType,
            itemCount: rawItems?.length || 0,
            fetchJobId,
        });

        let processed = 0;
        let duplicates = 0;
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
            failed,
            mediaEnqueued,
            aiEnqueued,
        });
    },
});
