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
import { cmsClient } from '../cms/client.js';
import { getQueue } from '../queues/index.js';
import type { RawFetchedItem } from '../fetchers/types.js';
import type { NormalizedItem } from '../normalizers/types.js';
import { sourceRunExecutionEnvelopeSchema } from '../contracts/source-runs.js';
import { buildSourceRunReceipt, enqueueSourceRunReceipt } from '../services/lifecycle-receipts.js';
import { startSourceRunLeaseHeartbeat } from '../services/source-run-lease.js';
import { aiPriorityForContentType } from '../services/ai-queue-priority.js';

interface SourceFilters {
    include_keywords?: string[];
    exclude_keywords?: string[];
    min_engagement?: number;
}

interface ModerationConfig {
    trusted_source?: boolean;
    blocked_keywords?: string[];
    min_content_length?: number;
}

interface TelegramDownloadRef {
    channelUsername: string;
    channelId?: string;
    messageId: number;
    mediaKind: 'audio' | 'voice' | 'video' | 'photo' | 'text';
    fileName?: string;
    mimeType?: string;
}

type ModerationDecision = 'auto_approved' | 'needs_review' | 'auto_rejected';

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

function parseModerationConfig(sourceSettings: Record<string, unknown> | undefined): ModerationConfig {
    const rawModeration = (sourceSettings?.moderation || {}) as Record<string, unknown>;

    return {
        trusted_source: Boolean(rawModeration.trusted_source),
        blocked_keywords: Array.isArray(rawModeration.blocked_keywords)
            ? rawModeration.blocked_keywords.filter((value): value is string => typeof value === 'string')
            : [],
        min_content_length: typeof rawModeration.min_content_length === 'number'
            ? rawModeration.min_content_length
            : 80,
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

function evaluateModerationDecision(
    normalized: NormalizedItem,
    moderationConfig: ModerationConfig
): { decision: ModerationDecision; reason: string } {
    if (moderationConfig.trusted_source) {
        return { decision: 'auto_approved', reason: 'trusted_source' };
    }

    const combinedText = getItemText(normalized);
    const blockedKeywords = moderationConfig.blocked_keywords || [];
    if (blockedKeywords.length > 0) {
        const matchedKeyword = blockedKeywords.find((keyword) =>
            combinedText.includes(keyword.toLowerCase())
        );
        if (matchedKeyword) {
            return { decision: 'auto_rejected', reason: `blocked_keyword:${matchedKeyword}` };
        }
    }

    const minContentLength = moderationConfig.min_content_length ?? 80;
    const textLength = combinedText.trim().length;
    const titleLength = normalized.title.trim().length;

    if (titleLength < 8) {
        return { decision: 'needs_review', reason: 'short_title' };
    }
    if (textLength < minContentLength) {
        return { decision: 'needs_review', reason: 'insufficient_content_length' };
    }

    return { decision: 'auto_approved', reason: 'rules_passed' };
}

export const normalizeWorker = createWorker({
    queueName: QUEUE_NAMES.NORMALIZE,
    processor: async (job: Job<NormalizeJob>, jobLogger): Promise<void> => {
        const { sourceId, sourceType, rawItems, fetchJobId, triggeredBy = 'schedule', sourceSettings, sourceRunRequestId, tenantId: jobTenantId, operatorPlanId, operatorStepId, idempotencyKey } = job.data;
		const durableEnvelope = job.data.sourceRun ? sourceRunExecutionEnvelopeSchema.parse(job.data.sourceRun) : undefined;
		const heartbeat = durableEnvelope ? startSourceRunLeaseHeartbeat(durableEnvelope, { requestId: job.id }) : undefined;
		try {
		if (durableEnvelope) {
			if (sourceId !== durableEnvelope.contentSourceId || jobTenantId !== durableEnvelope.tenantId || sourceRunRequestId !== durableEnvelope.sourceRunRequestId || !job.data.sourceRunPageId || !job.data.sourceRunBatchId) {
				throw new Error('CMS source-run normalize payload does not match its fenced envelope');
			}
			// The fenced begin CAS occurs before the first CMS upsert or downstream
			// handoff. A crash after this point is verification work, never a
			// blind replay of a batch with an uncertain consumer-visible effect.
			await cmsClient.beginSourceRunUnit({ tenantId: durableEnvelope.tenantId, requestId: durableEnvelope.sourceRunRequestId, attemptId: durableEnvelope.sourceRunAttemptId, unitId: durableEnvelope.executionUnitId, unitJobId: durableEnvelope.unitJobId, attemptFenceToken: durableEnvelope.attemptFenceToken, executionLeaseToken: durableEnvelope.executionLeaseToken }, job.id);
			await enqueueSourceRunReceipt(buildSourceRunReceipt({ envelope: durableEnvelope, stage: 'normalize', eventType: 'normalize_scheduled', outcome: 'no_change', sequence: 0, pageId: job.data.sourceRunPageId, batchId: job.data.sourceRunBatchId, payload: { item_count: rawItems?.length || 0 } }));
		}
        const tenantId = jobTenantId || tenantFromSourceSettings(sourceSettings);
        const sourceFilters = parseSourceFilters(sourceSettings);
        const moderationConfig = parseModerationConfig(sourceSettings);

        jobLogger.info('Processing normalize job', {
            sourceId,
            sourceType,
            itemCount: rawItems?.length || 0,
            fetchJobId,
        });

        let processed = 0;
        let duplicates = 0;
		// This is the exact count of CMS rows that received this fenced
		// execution-unit attribution. It intentionally includes repaired
		// duplicates, unlike `processed`, which counts only newly created rows.
		let cmsUpserted = 0;
        let filtered = 0;
        let failed = 0;
        let moderationApproved = 0;
        let moderationReview = 0;
        let moderationRejected = 0;
        let mediaEnqueued = 0;
        let aiEnqueued = 0;

        for (const rawItem of rawItems || []) {
            try {
				heartbeat?.assertCurrent();
                // Cast raw data back to RawFetchedItem
                const item = rawItem.rawData as unknown as RawFetchedItem;

                // Normalize the item
                const normalized = normalizeItem(item);
                if (!normalized) {
					await recordObservationDisposition(job, rawItem, 'filtered', undefined, 'normalization_unsupported');
                    failed++;
                    continue;
                }
				const recovery = (sourceSettings?.recovery ?? null) as { run_id?: string; manifest_hash?: string } | null;
				if (recovery?.run_id && recovery.manifest_hash) {
					normalized.recovery = { runId: recovery.run_id, manifestHash: recovery.manifest_hash };
				}

                const filterDecision = shouldSkipByFilters(normalized, item, sourceFilters);
                if (filterDecision.skip) {
					await recordObservationDisposition(job, rawItem, 'filtered', undefined, filterDecision.reason as 'include_keywords' | 'exclude_keywords' | 'min_engagement');
                    filtered++;
                    jobLogger.debug('Skipping item due to source filters', {
                        sourceId,
                        sourceType,
                        idempotencyKey: normalized.idempotencyKey,
                        reason: filterDecision.reason,
                    });
                    continue;
                }

                const moderation = evaluateModerationDecision(normalized, moderationConfig);

				// Redundancy hygiene is advisory for near matches. Exact durable URL
				// identity may reuse the existing idempotency skip; title/duration
				// matches are recorded as a hint and continue through the pipeline.
				if ((normalized.type === 'VIDEO' || normalized.type === 'PODCAST') && normalized.title) {
					const precheck = await cmsClient.redundancyPrecheck([{
						title: normalized.title,
						duration_sec: typeof normalized.durationSec === 'number' ? normalized.durationSec : undefined,
						source_url: normalized.originalUrl || undefined,
					}]);
					const verdict = precheck.candidates[0];
					if (verdict?.verdict === 'exact_identity') {
						await recordObservationDisposition(job, rawItem, 'filtered', undefined, 'exact_duplicate');
						duplicates++;
						continue;
					}
					if (verdict?.verdict === 'likely_duplicate') {
						normalized.metadata = { ...normalized.metadata, redundancyHint: verdict };
					}
				}
                normalized.metadata = {
                    ...normalized.metadata,
                    moderation: {
                        decision: moderation.decision,
                        reason: moderation.reason,
                        reviewed: false,
                        evaluated_at: new Date().toISOString(),
                    },
                };
                if (moderation.decision === 'auto_rejected') {
                    normalized.status = 'ARCHIVED';
                    moderationRejected++;
                } else if (moderation.decision === 'needs_review') {
                    normalized.status = 'PENDING';
                    moderationReview++;
                } else {
                    moderationApproved++;
                }
				if (durableEnvelope) {
					// Consumer-side attribution is persisted with the CMS upsert so a
					// later verifier can observe this exact batch without trusting a
					// worker counter or queue acknowledgement.
					normalized.metadata = {
						...normalized.metadata,
						source_run_execution_unit_id: durableEnvelope.executionUnitId,
						source_run_attempt_id: durableEnvelope.sourceRunAttemptId,
						source_run_page_id: job.data.sourceRunPageId,
						source_run_batch_id: job.data.sourceRunBatchId,
					};
				}

                // The cache only avoids duplicate source work. Never let it
                // suppress the deterministic downstream handoff: a prior
                // attempt may have created the CMS row and crashed before
                // queueing its required media/embedding stage.
                const dedupResult = await dedupService.checkDedup(normalized.idempotencyKey);
                if (dedupResult.isDuplicate) {
                    jobLogger.debug('Skipping duplicate', {
                        idempotencyKey: normalized.idempotencyKey,
                        existingId: dedupResult.existingId,
                    });
                }

                // Upsert to CMS
				const { contentItemId, created, retired, status: cmsStatus, disposition, deliveryMode } = await upsertContentItem(normalized, job.id, {
					tenantId, contentSourceId: sourceId, sourceRunRequestId, operatorPlanId, operatorStepId, idempotencyKey,
				});
				if (contentItemId) cmsUpserted++;
				if (moderation.decision === 'auto_rejected') {
					await recordObservationDisposition(job, rawItem, 'filtered', undefined, 'moderation_rejected');
				} else if (contentItemId) {
					await recordObservationDisposition(job, rawItem, 'materialized', contentItemId);
				}
				if (retired) {
					duplicates++;
					jobLogger.info('Skipping downstream work for retained News identity', { idempotencyKey: normalized.idempotencyKey });
					continue;
				}
				if (deliveryMode === 'durable_required') {
					if (created) processed++; else duplicates++;
					jobLogger.info('CMS durable stage manifest owns downstream delivery', {
						contentItemId, disposition, status: cmsStatus,
					});
					continue;
				}
				if (!created && (cmsStatus === 'READY' || cmsStatus === 'ARCHIVED')) {
					duplicates++;
					jobLogger.info('Skipping unchanged terminal compatibility item', { contentItemId, disposition, status: cmsStatus });
					continue;
				}

                if (created) {
                    processed++;

                    jobLogger.info('Content item created', {
                        contentItemId,
                        idempotencyKey: normalized.idempotencyKey,
                        type: normalized.type,
                        status: normalized.status,
                    });
                } else {
                    duplicates++;
                    jobLogger.info('Repairing downstream handoff for existing content item', { contentItemId });
                }

                    // Routing decision based on content type and media kind.
                    const telegramMediaKind = (normalized.metadata as Record<string, unknown>)?.mediaKind as string | undefined;

                    // Items that need the full media pipeline (download → transcode → thumbnail → AI)
                    const requiresMediaJob =
                        normalized.type === 'VIDEO' ||
                        normalized.type === 'PODCAST' ||
                        (normalized.type === 'ARTICLE' && sourceType === 'TELEGRAM' && telegramMediaKind === 'photo');

                    if (requiresMediaJob && normalized.status !== 'ARCHIVED') {
                        const mediaReady = Boolean((normalized.metadata as Record<string, unknown>)?.mediaReady);
                        const sourceUrl = normalized.mediaUrl || normalized.originalUrl;

                        if (mediaReady && normalized.mediaUrl) {
                            const aiQueue = getQueue(QUEUE_NAMES.AI);
                            if (!aiQueue) throw new Error('AI queue unavailable for required handoff');
                            await aiQueue.add(
                                    `ai-manual-${normalized.type}-${contentItemId}`,
                                    {
                                        contentItemId,
                                        tenantId,
                                        contentType: normalized.type,
                                        operations: ['transcript', 'embedding'],
                                        textContent: {
                                            title: normalized.title,
                                            excerpt: normalized.excerpt || undefined,
                                            bodyText: normalized.bodyText || undefined,
                                        },
                                        mediaUrl: normalized.mediaUrl,
                                    },
                                    // Deterministic id coalesces duplicate AI jobs on re-ingest.
                                    { priority: aiPriorityForContentType(normalized.type), jobId: `ai-${contentItemId}` }
                                );

                            aiEnqueued++;
                            jobLogger.debug('Enqueued AI job (manual media ready)', {
                                    contentItemId,
                                    type: normalized.type,
                            });
                        } else {
                            const mediaQueue = getQueue(QUEUE_NAMES.MEDIA);
                            if (!mediaQueue) throw new Error('Media queue unavailable for required handoff');
                                const downloadRef = (normalized.metadata as Record<string, unknown>)?.telegramDownloadRef as TelegramDownloadRef | undefined;
                                const mediaJobId = `media-${contentItemId}`;
                                const existingMediaJob = await mediaQueue.getJob(mediaJobId);
                                if (existingMediaJob) {
                                    const state = await existingMediaJob.getState();
                                    if (state === 'failed' || state === 'completed') {
                                        await existingMediaJob.remove();
                                    } else {
                                        jobLogger.debug('Media job already queued for content item', {
                                            contentItemId,
                                            state,
                                        });
                                        continue;
                                    }
                                }

                                await mediaQueue.add(
                                    `media-${normalized.type}-${contentItemId}`,
                                    {
                                        contentItemId,
                                        tenantId,
                                        contentType: normalized.type,
                                        sourceType,
                                        sourceUrl,
                                        textContent: {
                                            title: normalized.title,
                                            excerpt: normalized.excerpt || undefined,
                                            bodyText: normalized.bodyText || undefined,
                                        },
                                        downloadRef,
                                        operations: ['download', 'transcode', 'thumbnail'],
                                    },
                                    { priority: normalized.type === 'VIDEO' ? 2 : 3, jobId: mediaJobId }
                                );

                                mediaEnqueued++;
                                jobLogger.debug('Enqueued media job', { contentItemId, type: normalized.type });
                        }
                    } else if (normalized.status !== 'ARCHIVED') {
                        // Every non-media item requires an embedding before it can be READY.
                        const aiQueue = getQueue(QUEUE_NAMES.AI);
                        if (!aiQueue) throw new Error('AI queue unavailable for required handoff');
                        await aiQueue.add(
                                `ai-text-article-${contentItemId}`,
                                {
                                    contentItemId,
                                    contentType: normalized.type,
                                    operations: ['embedding'],
                                    textContent: {
                                        title: normalized.title,
                                        excerpt: normalized.excerpt || undefined,
                                        bodyText: normalized.bodyText || undefined,
                                    },
                                },
                                // Deterministic id coalesces duplicate AI jobs on re-ingest.
                                { priority: aiPriorityForContentType(normalized.type), jobId: `ai-${contentItemId}` }
                            );

                        aiEnqueued++;
                        jobLogger.debug('Enqueued AI job for text item', {
                                contentItemId,
                                type: normalized.type,
                        });
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
			cmsUpserted,
            filtered,
            failed,
            moderationApproved,
            moderationReview,
            moderationRejected,
            mediaEnqueued,
            aiEnqueued,
        });
		if (durableEnvelope) {
			// A partial batch is terminally failed at the unit level so the CMS
			// reducer can expose a truthful request-level partial outcome when
			// sibling batches succeeded. The receipts retain exact counts.
			if (!heartbeat) throw new Error('source-run heartbeat was not initialized');
			heartbeat.assertCurrent();
			await enqueueSourceRunReceipt(buildSourceRunReceipt({
				envelope: durableEnvelope, stage: 'normalize', eventType: 'normalize_terminal',
				outcome: failed > 0 ? 'provider_failed' : processed > 0 ? 'new_items' : 'no_change', sequence: 1,
				pageId: job.data.sourceRunPageId, batchId: job.data.sourceRunBatchId,
				payload: { processed, duplicates, cms_upserted: cmsUpserted, filtered, failed, moderation_approved: moderationApproved, moderation_review: moderationReview, moderation_rejected: moderationRejected, media_enqueued: mediaEnqueued, ai_enqueued: aiEnqueued },
			}));
			return;
		}
        await reportNormalizeRun(tenantId, sourceId, sourceRunRequestId, fetchJobId, triggeredBy, processed, duplicates, filtered, failed, {
            sourceType,
            moderationApproved,
            moderationReview,
            moderationRejected,
            mediaEnqueued,
            aiEnqueued,
        });
		} finally {
			heartbeat?.stop();
		}
    },
});

async function recordObservationDisposition(
	job: Job<NormalizeJob>, rawItem: { upstreamObservationId?: string }, disposition: 'materialized' | 'filtered',
	contentItemId?: string,
	filterClass?: 'include_keywords' | 'exclude_keywords' | 'min_engagement' | 'moderation_rejected' | 'normalization_unsupported' | 'exact_duplicate',
): Promise<void> {
	if (!rawItem.upstreamObservationId || !job.data.sourceRun) return;
	const envelope = sourceRunExecutionEnvelopeSchema.parse(job.data.sourceRun);
	await cmsClient.recordSourceRunUpstreamObservationDisposition({
		tenantId: envelope.tenantId, requestId: envelope.sourceRunRequestId,
		attemptId: envelope.sourceRunAttemptId, unitId: envelope.executionUnitId,
		unitJobId: envelope.unitJobId, attemptFenceToken: envelope.attemptFenceToken,
		executionLeaseToken: envelope.executionLeaseToken, observationId: rawItem.upstreamObservationId,
		disposition, contentItemId, filterClass,
	}, job.id);
}

function tenantFromSourceSettings(settings?: Record<string, unknown>): string {
    const circulation = settings?.circulation;
    if (circulation && typeof circulation === 'object' && !Array.isArray(circulation)) {
        const tenantId = (circulation as { tenantId?: unknown }).tenantId;
        if (typeof tenantId === 'string' && tenantId.trim()) {
            return tenantId.trim();
        }
    }
    return 'default';
}

async function reportNormalizeRun(
    tenantId: string,
    sourceId: string,
	sourceRunRequestId: string | undefined,
    fetchJobId: string,
    triggeredBy: 'schedule' | 'manual',
    accepted: number,
    duplicates: number,
    filtered: number,
    failed: number,
    metadata: Record<string, unknown>
): Promise<void> {
    if (!fetchJobId || !isUuid(sourceId)) return;
    try {
        await cmsClient.reportSourceRun({
            tenant_id: tenantId,
            source_id: sourceId,
			source_run_request_id: sourceRunRequestId,
            job_id: fetchJobId,
            triggered_by: triggeredBy,
            accepted,
            duplicates,
            filtered,
            failed,
            finished_at: new Date().toISOString(),
			metadata: { ...metadata, stage: 'normalize' },
        }, fetchJobId);
    } catch {
        // Telemetry should never fail normalization.
    }
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
