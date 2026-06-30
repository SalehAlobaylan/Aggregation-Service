/**
 * Storage circulation service.
 *
 * Owns bounded storage relief for one tenant.
 * Used by:
 *   - the storage worker's repeatable BullMQ tick
 *   - the manual `/admin/storage/sweep` endpoint
 */
import { cmsClient } from '../cms/client.js';
import {
    deleteContentObjects,
    computeStorageUsage,
    listAllObjects,
    moveObjectBetweenTiers,
    isColdTierConfigured,
} from '../storage/client.js';
import { logger } from '../observability/logger.js';
import type { StoragePolicy, MoveToColdItem } from '../cms/types.js';
import { getQueue, QUEUE_NAMES, type QualityReencodeJob } from '../queues/index.js';

export interface SweepResult {
    tenantId: string;
    deletedCount: number;
    movedToColdCount?: number;
    reEncodedCount?: number;
    freedBytes: number;
    skipped: boolean;
    reason?: string;
    error?: string;
}

/**
 * Run one sweep cycle for the given policy. Returns a SweepResult and writes
 * a sweep-run row back to CMS. Safe to call when policy is disabled — it
 * returns `skipped: true` without touching storage.
 */
export async function runSweepForTenant(
    policy: StoragePolicy,
    trigger: 'auto' | 'manual' = 'auto'
): Promise<SweepResult> {
    const tenantId = policy.tenant_id ?? 'default';
    const startedAt = new Date().toISOString();

    if (!policy.enabled && trigger === 'auto') {
        return { tenantId, deletedCount: 0, freedBytes: 0, skipped: true, reason: 'policy disabled' };
    }

    // Soft cap: auto sweeps respect the Class A budget so a runaway sweep can't
    // blow through the free tier. Manual triggers bypass — operator override.
    if (trigger === 'auto') {
        try {
            const budget = await cmsClient.getStorageOpBudget(tenantId);
            if (budget.class_a_status === 'cap') {
                logger.warn('Storage sweep skipped — Class A budget cap reached', {
                    tenantId,
                    used: budget.class_a_used,
                    budget: budget.class_a_budget,
                });
                return {
                    tenantId,
                    deletedCount: 0,
                    freedBytes: 0,
                    skipped: true,
                    reason: 'class_a_budget_cap',
                };
            }
        } catch (err) {
            // CMS unreachable for budget check — let the sweep run rather than
            // silently freezing. The budget is a soft guardrail, not a hard one.
            logger.warn('Storage sweep: budget check failed, proceeding without cap', { err });
        }
    }

    let deletedCount = 0;
    let movedToColdCount = 0;
    let reEncodedCount = 0;
    let freedBytes = 0;
    let errorMessage: string | undefined;

    try {
        // Figure out how many bytes we need to free
        const usage = await computeStorageUsage();
        const targetBytes = Math.floor(
            (policy.max_storage_bytes * policy.target_utilization_pct) / 100
        );
        const overage = usage.usedBytes - targetBytes;

        if (overage <= 0 && trigger === 'auto') {
            const finishedAt = new Date().toISOString();
            await cmsClient.createSweepRun({
                tenant_id: tenantId,
                started_at: startedAt,
                finished_at: finishedAt,
                deleted_count: 0,
                freed_bytes: 0,
                trigger,
            });
            return { tenantId, deletedCount: 0, freedBytes: 0, skipped: true, reason: 'under target' };
        }

        // Manual triggers always do at least one batch worth. Auto triggers cap at the overage.
        const maxBytes = trigger === 'manual' && overage <= 0 ? undefined : Math.max(overage, 0);

        const candidates = await cmsClient.listStorageCandidates({
            tenant_id: tenantId,
            min_age_days: policy.min_age_days,
            max_view_count: policy.min_view_count_for_keep,
            delete_failed_immediately: policy.delete_failed_immediately,
            include_atomized_parents: true,
            archive_action: policy.archive_action,
            limit: 1000,
            max_bytes: maxBytes,
        });

        if (candidates.data.length === 0) {
            const finishedAt = new Date().toISOString();
            await cmsClient.createSweepRun({
                tenant_id: tenantId,
                started_at: startedAt,
                finished_at: finishedAt,
                deleted_count: 0,
                freed_bytes: 0,
                trigger,
            });
            return { tenantId, deletedCount: 0, freedBytes: 0, skipped: true, reason: 'no candidates' };
        }

        const artifacts = policy.preserve_thumbnails
            ? ['processed', 'original']
            : ['processed', 'original', 'thumbnail'];

        const configuredAction = policy.archive_action ?? 're_encode';
        const moveToCold = configuredAction === 'move_to_cold' && isColdTierConfigured();
        const action = configuredAction === 'move_to_cold' && !moveToCold ? 're_encode' : configuredAction;
        if (configuredAction === 'move_to_cold' && !moveToCold) {
            logger.warn('storage.sweep: archive_action=move_to_cold but cold tier is not configured; falling back to re-encode guardrails', {
                tenantId,
            });
        }

        if (action === 'delete' && trigger === 'auto') {
            for (const candidate of candidates.data) {
                await cmsClient.recordStorageArtifactEvent({
                    tenant_id: tenantId,
                    content_item_id: candidate.id,
                    event_type: 'recoverable_deleted',
                    status: 'approval_required',
                    reason: isColdTierConfigured()
                        ? 'auto_delete_requires_approval'
                        : 'degraded_no_cold_delete_requires_approval',
                    trigger,
                    source: 'aggregation_storage_sweep',
                    old_media_url: candidate.media_url,
                    old_size_bytes: candidate.file_size_bytes,
                    artifact_keys: { artifacts },
                    recovery_payload: {
                        original_url: candidate.original_url,
                        source_feed_url: candidate.source_feed_url,
                        source_episode_id: candidate.source_episode_id,
                        parent_content_item_id: candidate.parent_content_item_id,
                        is_feed_unit: candidate.is_feed_unit,
                        feed_visibility: candidate.feed_visibility,
                        duration_sec: candidate.duration_sec,
                        media_suitability: candidate.media_suitability,
                    },
                }).catch(err => logger.warn('storage.sweep: failed to record delete approval requirement', {
                    err,
                    contentId: candidate.id,
                }));
            }
            errorMessage = isColdTierConfigured()
                ? 'auto_delete_requires_approval'
                : 'degraded_no_cold_delete_requires_approval';
            logger.warn('storage.sweep: automatic recoverable delete requires approval; no objects were deleted', {
                tenantId,
                candidateCount: candidates.data.length,
                coldTierConfigured: isColdTierConfigured(),
            });
        } else if (action === 're_encode') {
            // Enqueue one QUALITY_REENCODE job per candidate. We don't wait
            // for them here — they run async on the quality.worker queue and
            // patch CMS as each completes. The sweep run row records the
            // count enqueued; cumulative byte savings emerge via the
            // per-item `current_quality_profile_id` + `file_size_bytes`
            // updates the re-encode worker performs.
            const queue = getQueue(QUEUE_NAMES.QUALITY_REENCODE);
            if (!queue) {
                logger.error('storage.sweep: QUALITY_REENCODE queue not initialised; cannot re-encode', { tenantId });
                errorMessage = 'quality_queue_not_initialised';
            } else {
                const roleProfileCache = new Map<string, number>();
                for (const candidate of candidates.data) {
                    const targetId = await resolveReencodeTargetForRole(policy, candidate, roleProfileCache);
                    const contentRole = candidate.content_role ?? storageRoleForCandidate(candidate);
                    const payload: QualityReencodeJob = {
                        contentItemId: candidate.id,
                        targetProfileId: targetId,
                        tenantId,
                        trigger: trigger === 'manual' ? 'manual' : 'rule',
                        contentRole,
                    };
                    try {
                        const jobId = buildReencodeJobId(tenantId, candidate.id, targetId, contentRole);
                        const existing = await queue.getJob(jobId);
                        if (existing) {
                            logger.info('storage.sweep: re-encode already queued; skipping duplicate', {
                                contentId: candidate.id,
                                jobId,
                                state: await existing.getState().catch(() => 'unknown'),
                            });
                            await cmsClient.recordStorageArtifactEvent({
                                tenant_id: tenantId,
                                content_item_id: candidate.id,
                                event_type: 'reencoded',
                                status: 'skipped',
                                reason: 'already_queued',
                                trigger,
                                source: 'aggregation_storage_sweep',
                                old_media_url: candidate.media_url,
                                old_size_bytes: candidate.file_size_bytes,
                                artifact_keys: { job_id: jobId, content_role: contentRole, target_profile_id: targetId },
                            }).catch(err => logger.warn('storage.sweep: failed to record duplicate re-encode skip', {
                                err,
                                contentId: candidate.id,
                            }));
                            continue;
                        }
                        await queue.add('reencode', payload, {
                            jobId,
                            // Storage-driven re-encodes are lower priority than
                            // direct admin actions so they queue behind manual work.
                            priority: trigger === 'manual' ? 0 : 5,
                            attempts: 2,
                            backoff: { type: 'exponential', delay: 30_000 },
                            removeOnComplete: { age: 86400, count: 500 },
                            removeOnFail: { age: 86400 },
                        });
                        reEncodedCount++;
                    } catch (err) {
                        logger.error('storage.sweep: failed to enqueue re-encode', err, {
                            contentId: candidate.id,
                        });
                        await cmsClient.recordStorageArtifactEvent({
                            tenant_id: tenantId,
                            content_item_id: candidate.id,
                            event_type: 'reencoded',
                            status: 'error',
                            reason: 'queue_enqueue_failed',
                            trigger,
                            source: 'aggregation_storage_sweep',
                            old_media_url: candidate.media_url,
                            old_size_bytes: candidate.file_size_bytes,
                            artifact_keys: { content_role: contentRole, target_profile_id: targetId },
                            error: err instanceof Error ? err.message : String(err),
                        }).catch(writeErr => logger.warn('storage.sweep: failed to record re-encode enqueue error', {
                            err: writeErr,
                            contentId: candidate.id,
                        }));
                    }
                }
            }
        } else if (moveToCold) {
            const movedItems: MoveToColdItem[] = [];
            for (const candidate of candidates.data) {
                try {
                    const moveResult = await moveObjectBetweenTiers(
                        candidate.id,
                        'primary',
                        'cold',
                        artifacts
                    );
                    if (moveResult.movedCount === 0) {
                        // Nothing moved (probably already gone) — skip the CMS update so
                        // we don't lie about the URL change.
                        await cmsClient.recordStorageArtifactEvent({
                            tenant_id: tenantId,
                            content_item_id: candidate.id,
                            event_type: 'moved_cold',
                            status: 'skipped',
                            reason: 'no_objects_moved',
                            trigger,
                            source: 'aggregation_storage_sweep',
                            old_media_url: candidate.media_url,
                            old_size_bytes: candidate.file_size_bytes,
                            artifact_keys: { artifacts },
                        }).catch(err => logger.warn('storage.sweep: failed to record cold move skip', {
                            err,
                            contentId: candidate.id,
                        }));
                        continue;
                    }
                    // Track moves separately from deletes so the sweep-run row
                    // distinguishes the two actions.
                    movedToColdCount += moveResult.movedCount;
                    freedBytes += moveResult.bytesMoved || candidate.file_size_bytes;
                    movedItems.push({
                        id: candidate.id,
                        media_url: moveResult.newPrimaryUrls['processed'] ?? moveResult.newPrimaryUrls['original'],
                        thumbnail_url: moveResult.newPrimaryUrls['thumbnail'],
                        new_size_bytes: moveResult.bytesMoved,
                    });
                    if (moveResult.errors.length > 0) {
                        logger.warn('storage.sweep: partial move errors', {
                            contentId: candidate.id,
                            errors: moveResult.errors,
                        });
                    }
                } catch (err) {
                    logger.error('storage.sweep: failed to move to cold', err, {
                        contentId: candidate.id,
                    });
                    await cmsClient.recordStorageArtifactEvent({
                        tenant_id: tenantId,
                        content_item_id: candidate.id,
                        event_type: 'moved_cold',
                        status: 'error',
                        reason: 'move_to_cold_failed',
                        trigger,
                        source: 'aggregation_storage_sweep',
                        old_media_url: candidate.media_url,
                        old_size_bytes: candidate.file_size_bytes,
                        artifact_keys: { artifacts },
                        error: err instanceof Error ? err.message : String(err),
                    }).catch(writeErr => logger.warn('storage.sweep: failed to record cold move error', {
                        err: writeErr,
                        contentId: candidate.id,
                    }));
                }
            }

            if (movedItems.length > 0) {
                try {
                    await cmsClient.moveItemsToCold({ items: movedItems });
                } catch (err) {
                    logger.error('storage.sweep: failed to flag moved items in CMS', err, {
                        count: movedItems.length,
                    });
                }
            }
        } else {
            // delete-from-primary path
            const archivedIds: string[] = [];
            for (const candidate of candidates.data) {
                try {
                    const result = await deleteContentObjects(candidate.id, artifacts);
                    if (result.errors.length > 0) {
                        logger.warn('storage.sweep: partial delete errors', {
                            contentId: candidate.id,
                            errors: result.errors,
                        });
                    }
                    deletedCount += result.deletedCount;
                    freedBytes += result.freedBytes || candidate.file_size_bytes;
                    archivedIds.push(candidate.id);
                } catch (err) {
                    logger.error('storage.sweep: failed to delete objects', err, {
                        contentId: candidate.id,
                    });
                    await cmsClient.recordStorageArtifactEvent({
                        tenant_id: tenantId,
                        content_item_id: candidate.id,
                        event_type: 'recoverable_deleted',
                        status: 'error',
                        reason: 'delete_objects_failed',
                        trigger,
                        source: 'aggregation_storage_sweep',
                        old_media_url: candidate.media_url,
                        old_size_bytes: candidate.file_size_bytes,
                        artifact_keys: { artifacts },
                        error: err instanceof Error ? err.message : String(err),
                    }).catch(writeErr => logger.warn('storage.sweep: failed to record delete error', {
                        err: writeErr,
                        contentId: candidate.id,
                    }));
                }
            }

            if (archivedIds.length > 0) {
                try {
                    await cmsClient.archiveItems({
                        ids: archivedIds,
                        preserve_thumbnails: policy.preserve_thumbnails,
                    });
                } catch (err) {
                    logger.error('storage.sweep: failed to archive in CMS', err, {
                        count: archivedIds.length,
                    });
                }
            }
        }
    } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        logger.error('storage.sweep: unhandled error', err, { tenantId });
    }

    const finishedAt = new Date().toISOString();
    try {
        await cmsClient.createSweepRun({
            tenant_id: tenantId,
            started_at: startedAt,
            finished_at: finishedAt,
            deleted_count: deletedCount,
            moved_to_cold_count: movedToColdCount,
            re_encoded_count: reEncodedCount,
            freed_bytes: freedBytes,
            trigger,
            error: errorMessage,
        });
    } catch (err) {
        logger.error('storage.sweep: failed to record sweep run', err, { tenantId });
    }

    return {
        tenantId,
        deletedCount,
        movedToColdCount,
        reEncodedCount,
        freedBytes,
        skipped: false,
        error: errorMessage,
    };
}

async function resolveReencodeTargetForRole(
    policy: StoragePolicy,
    candidate: { tenant_id?: string; type?: string; content_role?: string; media_suitability?: string },
    cache: Map<string, number>
): Promise<number> {
    if (policy.re_encode_target_profile_id && policy.re_encode_target_profile_id > 0) {
        return policy.re_encode_target_profile_id;
    }
    const role = candidate.content_role ?? storageRoleForCandidate(candidate);
    const presetKey = presetKeyForStorageRole(role);
    if (!presetKey) return 0;

    const tenantId = candidate.tenant_id ?? policy.tenant_id ?? undefined;
    const sourceType = candidate.type;
    const cacheKey = `${tenantId ?? ''}:${sourceType ?? ''}:${presetKey}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey) ?? 0;

    try {
        const resolved = await cmsClient.resolveQualityProfile({
            tenant_id: tenantId,
            source_type: sourceType,
            preset_key: presetKey,
        });
        const id = resolved?.profile?.id ?? 0;
        cache.set(cacheKey, id);
        return id;
    } catch (err) {
        logger.warn('storage.sweep: role profile resolution failed; falling back to per-item profile', {
            err,
            role,
            presetKey,
            tenantId,
            sourceType,
        });
        cache.set(cacheKey, 0);
        return 0;
    }
}

function presetKeyForStorageRole(role: string): string | null {
    switch (role) {
        case 'atomized_parent_source':
        case 'dormant_feed_unit':
        case 'unsuitable_media':
        case 'failed_or_orphan_artifact':
            return 'storage-saver';
        case 'normal_feed_unit':
            return 'mobile-feed';
        case 'hot_feed_unit':
            return 'high-quality';
        default:
            return null;
    }
}

function storageRoleForCandidate(candidate: { status?: string; is_feed_unit?: boolean; feed_visibility?: string; duration_sec?: number; parent_content_item_id?: string; media_suitability?: string; view_count?: number }): string {
    if (candidate.status === 'FAILED') return 'failed_or_orphan_artifact';
    if (candidate.media_suitability === 'visual_dependent' || candidate.media_suitability === 'unsuitable') return 'unsuitable_media';
    if (!candidate.parent_content_item_id && candidate.is_feed_unit === false && (candidate.duration_sec ?? 0) > 2400) return 'atomized_parent_source';
    if (candidate.is_feed_unit && candidate.feed_visibility === 'visible') {
        return (candidate.view_count ?? 0) <= 5 ? 'dormant_feed_unit' : 'normal_feed_unit';
    }
    return 'dormant_feed_unit';
}

function buildReencodeJobId(
    tenantId: string,
    contentItemId: string,
    targetProfileId: number,
    contentRole: string
): string {
    const safe = (value: string) =>
        value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';

    return [
        'reencode',
        safe(tenantId),
        safe(contentItemId),
        String(targetProfileId),
        safe(contentRole),
    ].join('-');
}

/**
 * Reconcile S3 against CMS: report orphan keys (in S3, not referenced) and
 * missing objects (DB has media_url, S3 doesn't).
 */
export async function reconcileStorage(): Promise<{
    orphanKeys: string[];
    missingObjects: string[];
    orphanCount: number;
    missingCount: number;
}> {
    // 1) Build set of every key currently in S3
    const s3Keys = new Set<string>();
    for await (const page of listAllObjects()) {
        for (const obj of page) {
            if (obj.Key) s3Keys.add(obj.Key);
        }
    }

    // 2) Walk CMS items and figure out which keys we expect
    const expectedKeys = new Set<string>();
    const missing: string[] = [];

    let page = 1;
    const limit = 500;
    while (true) {
        const list = await cmsClient.listContentItems({ page, limit });
        if (!list.data || list.data.length === 0) break;

        for (const item of list.data) {
            // The original_url field in the response holds the *source* URL,
            // not a storage key. We only know storage keys are derived from
            // contentItemId. Inspect S3 to see which artifacts exist.
            const id = item.id;
            const expected = ['processed', 'thumbnail', 'original'];
            for (const art of expected) {
                // Look for any extension (.mp4, .jpg, .json etc.) — we just
                // check whether at least one key matches `content/{id}/{art}.*`
                let found = false;
                for (const key of s3Keys) {
                    if (key.startsWith(`content/${id}/${art}.`)) {
                        expectedKeys.add(key);
                        found = true;
                        break;
                    }
                }
                if (!found && art === 'processed' && item.metadata && (item.metadata as Record<string, unknown>)['expects_processed']) {
                    missing.push(`content/${id}/${art}.*`);
                }
            }
        }

        if (list.data.length < limit) break;
        page += 1;
        if (page > 100) break; // safety net
    }

    const orphanKeys: string[] = [];
    for (const key of s3Keys) {
        if (!expectedKeys.has(key)) orphanKeys.push(key);
    }

    return {
        orphanKeys,
        missingObjects: missing,
        orphanCount: orphanKeys.length,
        missingCount: missing.length,
    };
}
