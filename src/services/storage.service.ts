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
    artifactFamilyForKey,
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

export interface SweepOptions {
    candidateIds?: string[];
    maxBytes?: number;
    limit?: number;
    archiveAction?: 'move_to_cold' | 're_encode';
    correlationId?: string;
    ownerRequestId?: string;
    idempotencyKey?: string;
    manifestHash?: string;
}

/**
 * Run one sweep cycle for the given policy. Returns a SweepResult and writes
 * a sweep-run row back to CMS. Safe to call when policy is disabled — it
 * returns `skipped: true` without touching storage.
 */
export async function runSweepForTenant(
    policy: StoragePolicy,
    trigger: 'auto' | 'manual' | 'retention' = 'auto',
    options: SweepOptions = {}
): Promise<SweepResult> {
    const tenantId = policy.tenant_id ?? 'default';
    const startedAt = new Date().toISOString();
	// Every object mutation has one durable, per-run idempotency root. Owner
	// calls supply their action key; legacy worker/admin runs receive a fresh
	// run key and still cannot mutate without a prepared CMS saga.
	const operationIdempotencyKey = options.idempotencyKey ?? `storage-${trigger}-${tenantId}-${startedAt}`;

    if (!policy.enabled) {
        return { tenantId, deletedCount: 0, freedBytes: 0, skipped: true, reason: 'policy disabled' };
    }

    // Every caller shares the policy and budget guard. The Retention bridge is
    // not an escape hatch around Storage's own cost controls.
    {
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
            logger.warn('Storage sweep: budget check failed; skipping', { err });
            return { tenantId, deletedCount: 0, freedBytes: 0, skipped: true, reason: 'budget_proof_unavailable' };
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

        const scopedCandidateIds = [...new Set((options.candidateIds ?? []).map(id => id.trim()).filter(Boolean))];
        const scoped = scopedCandidateIds.length > 0;

        if (overage <= 0 && trigger === 'auto' && !scoped) {
            const finishedAt = new Date().toISOString();
            await cmsClient.createSweepRun({
                tenant_id: tenantId,
                started_at: startedAt,
                finished_at: finishedAt,
                deleted_count: 0,
                freed_bytes: 0,
                trigger,
                correlation_id: options.correlationId,
                owner_request_id: options.ownerRequestId,
                idempotency_key: options.idempotencyKey,
                manifest_hash: options.manifestHash,
            });
            return { tenantId, deletedCount: 0, freedBytes: 0, skipped: true, reason: 'under target' };
        }

        // Manual triggers normally do at least one batch worth. Scoped Autopilot
        // sweeps pass an explicit maxBytes/candidateIds set, so they never expand
        // to the general candidate pool.
        const requestedMaxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : undefined;
        const maxBytes = requestedMaxBytes ?? (trigger !== 'auto' && overage <= 0 ? undefined : Math.max(overage, 0));
        const archiveAction = options.archiveAction ?? policy.archive_action;
        const limit = Math.max(1, Math.min(options.limit ?? (scoped ? scopedCandidateIds.length : 1000), 1000));

        const candidates = await cmsClient.listStorageCandidates({
            tenant_id: tenantId,
            min_age_days: policy.min_age_days,
            max_view_count: policy.min_view_count_for_keep,
            delete_failed_immediately: policy.delete_failed_immediately,
            include_atomized_parents: true,
            archive_action: archiveAction,
            limit,
            max_bytes: maxBytes,
            ids: scopedCandidateIds,
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
                correlation_id: options.correlationId,
                owner_request_id: options.ownerRequestId,
                idempotency_key: options.idempotencyKey,
                manifest_hash: options.manifestHash,
            });
            return { tenantId, deletedCount: 0, freedBytes: 0, skipped: true, reason: 'no candidates' };
        }

        const artifacts = policy.preserve_thumbnails
            ? ['processed', 'original']
            : ['processed', 'original', 'thumbnail'];

        const configuredAction = archiveAction ?? 're_encode';
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
                    if (!candidate.media_url || contentRole === 'failed_or_orphan_artifact') {
                        await cmsClient.recordStorageArtifactEvent({
                            tenant_id: tenantId,
                            content_item_id: candidate.id,
                            event_type: 'reencoded',
                            status: 'skipped',
                            reason: !candidate.media_url ? 'missing_media_url' : 'failed_or_orphan_artifact',
                            trigger,
                            source: 'aggregation_storage_sweep',
                            old_media_url: candidate.media_url,
                            old_size_bytes: candidate.file_size_bytes,
                            artifact_keys: { content_role: contentRole, target_profile_id: targetId },
                        }).catch(err => logger.warn('storage.sweep: failed to record unsafe re-encode skip', {
                            err,
                            contentId: candidate.id,
                        }));
                        continue;
                    }
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
					const saga = await cmsClient.startStorageOperationSaga({
						tenant_id: tenantId,
						content_item_id: candidate.id,
						operation: 'move_to_cold',
						idempotency_key: operationIdempotencyKey,
						manifest_hash: options.manifestHash,
						correlation_id: options.correlationId,
						owner_request_id: options.ownerRequestId,
						evidence: { old_size_bytes: candidate.file_size_bytes, old_media_url: candidate.media_url ?? null, from_tier: 'primary', to_tier: 'cold' },
					});
					if (!saga.created) throw new Error(`storage operation saga already exists in ${saga.state}; reconciliation required`);
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
					if (moveResult.errors.length > 0) {
						throw new Error('object move was partial; CMS references were not changed');
					}
					await cmsClient.markStorageSagaObjectApplied(saga.id, {
						moved_count: moveResult.movedCount,
						bytes_moved: moveResult.bytesMoved,
						new_primary_urls: moveResult.newPrimaryUrls,
						errors: moveResult.errors,
					});
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
                    await cmsClient.moveItemsToCold({ items: movedItems, tenant_id: tenantId, idempotency_key: operationIdempotencyKey, manifest_hash: options.manifestHash, correlation_id: options.correlationId, owner_request_id: options.ownerRequestId });
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
					const saga = await cmsClient.startStorageOperationSaga({
						tenant_id: tenantId,
						content_item_id: candidate.id,
						operation: 'recoverable_delete',
						idempotency_key: operationIdempotencyKey,
						manifest_hash: options.manifestHash,
						correlation_id: options.correlationId,
						owner_request_id: options.ownerRequestId,
						evidence: { old_size_bytes: candidate.file_size_bytes, old_media_url: candidate.media_url ?? null, artifacts },
					});
					if (!saga.created) throw new Error(`storage operation saga already exists in ${saga.state}; reconciliation required`);
                    const result = await deleteContentObjects(candidate.id, artifacts);
                    if (result.errors.length > 0) {
                        logger.warn('storage.sweep: partial delete errors', {
                            contentId: candidate.id,
                            errors: result.errors,
                        });
                    }
                    if (result.errors.length > 0) {
						throw new Error('object deletion was partial; CMS references were not changed');
					}
					await cmsClient.markStorageSagaObjectApplied(saga.id, {
						deleted_count: result.deletedCount,
						freed_bytes: result.freedBytes,
						artifacts,
					});
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
						tenant_id: tenantId,
						idempotency_key: operationIdempotencyKey,
						manifest_hash: options.manifestHash,
						correlation_id: options.correlationId,
						owner_request_id: options.ownerRequestId,
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
            correlation_id: options.correlationId,
            owner_request_id: options.ownerRequestId,
            idempotency_key: options.idempotencyKey,
            manifest_hash: options.manifestHash,
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
    scannedObjectCount: number;
    scannedCmsItemCount: number;
    partial: boolean;
    truncatedReason?: string;
}> {
    // 1) Build a complete, paginated inventory. This endpoint is diagnostic;
    // partial reconciliation hides the exact historic prefixes operators need
    // to classify before any cleanup decision.
    const s3Keys = new Set<string>();
    const keysByContentId = new Map<string, Set<string>>();
    const processedByContentId = new Set<string>();
    for await (const page of listAllObjects()) {
        for (const obj of page) {
            if (!obj.Key) continue;
            s3Keys.add(obj.Key);
            const parsed = parseContentObjectKey(obj.Key);
            if (parsed) {
                const keys = keysByContentId.get(parsed.contentId) ?? new Set<string>();
                keys.add(obj.Key);
                keysByContentId.set(parsed.contentId, keys);
                if (parsed.artifact === 'processed') {
                    processedByContentId.add(parsed.contentId);
                }
            }
        }
    }

    // 2) Resolve the CMS rows that correspond to observed object IDs. This is
    // intentionally indexed by id; the previous nested key-per-item scan made
    // reconcile slow enough to trip the Console proxy timeout.
    const cmsIdsWithObjects = new Set<string>();
    const resolvedObjectIds = new Set<string>();
    const objectIds = Array.from(keysByContentId.keys());
    for (let i = 0; i < objectIds.length; i += 100) {
        const ids = objectIds.slice(i, i + 100);
        if (ids.length === 0) continue;
        ids.forEach(id => resolvedObjectIds.add(id));
        const list = await cmsClient.listContentItems({ ids, limit: ids.length });
        for (const item of list.data ?? []) {
            cmsIdsWithObjects.add(item.id);
        }
    }

    // 3) Walk all CMS pages to report expected processed artifacts that are
    // missing. The object inventory above remains the source of truth for
    // physical prefix presence.
    const expectedKeys = new Set<string>();
    const missing: string[] = [];

    let page = 1;
    const limit = 500;
    let scannedCmsItemCount = 0;
    while (true) {
        const list = await cmsClient.listContentItems({ page, limit });
        if (!list.data || list.data.length === 0) break;

        for (const item of list.data) {
            scannedCmsItemCount += 1;
            const keys = keysByContentId.get(item.id);
            if (keys) {
                keys.forEach(key => expectedKeys.add(key));
            }
            if (item.metadata && (item.metadata as Record<string, unknown>)['expects_processed'] && !processedByContentId.has(item.id)) {
                missing.push(`content/${item.id}/processed.*`);
            }
        }
        if (list.data.length < limit) break;
        page += 1;
    }

    const orphanKeys: string[] = [];
    for (const key of s3Keys) {
        const parsed = parseContentObjectKey(key);
        if (parsed) {
            if (resolvedObjectIds.has(parsed.contentId) && !cmsIdsWithObjects.has(parsed.contentId)) {
                orphanKeys.push(key);
            }
            continue;
        }
        if (!expectedKeys.has(key)) {
            orphanKeys.push(key);
        }
    }

    return {
        orphanKeys,
        missingObjects: missing,
        orphanCount: orphanKeys.length,
        missingCount: missing.length,
        scannedObjectCount: s3Keys.size,
        scannedCmsItemCount,
        partial: false,
    };
}

function parseContentObjectKey(key: string): { contentId: string; artifact: string } | null {
    const parts = key.split('/');
    if (parts.length < 3 || parts[0] !== 'content' || !parts[1]) {
        return null;
    }
    const filename = parts[parts.length - 1] ?? '';
    const dot = filename.lastIndexOf('.');
    const artifact = artifactFamilyForKey(key) ?? (dot > 0 ? filename.slice(0, dot) : filename);
    return { contentId: parts[1], artifact };
}
