/**
 * Fetch Worker - handles content fetching from sources
 * Phase 2: Full implementation with source routing
 */
import { Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type FetchJob } from '../queues/index.js';
import { fetchFromSource, type SourceConfig } from '../fetchers/index.js';
import { getQueue } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { sourceRunExecutionEnvelopeSchema, sourceRunManifestChildDigest, sourceRunQueueJobId, type SourceRunExecutionEnvelope } from '../contracts/source-runs.js';
import { buildSourceRunReceipt, enqueueSourceRunReceipt } from '../services/lifecycle-receipts.js';
import { startSourceRunLeaseHeartbeat } from '../services/source-run-lease.js';
import type { RawFetchedItem } from '../fetchers/types.js';

const SOURCE_RUN_NORMALIZE_BATCH_SIZE = 100;

function durableEnvelope(parent: SourceRunExecutionEnvelope, unit: { id: string; job_id: string; attempt_fence_token: string }, lease: { execution_lease_token: string; execution_lease_expires_at: string }): SourceRunExecutionEnvelope {
    return {
        contractVersion: 'source-run/v1', tenantId: parent.tenantId,
        sourceRunRequestId: parent.sourceRunRequestId, sourceRunAttemptId: parent.sourceRunAttemptId,
        executionUnitId: unit.id, contentSourceId: parent.contentSourceId,
        attemptFenceToken: unit.attempt_fence_token, executionLeaseToken: lease.execution_lease_token,
        executionLeaseExpiresAt: lease.execution_lease_expires_at, unitJobId: unit.job_id,
    };
}

function durablePageID(cursor: string): string {
    return `page-${createHash('sha256').update(cursor, 'utf8').digest('hex').slice(0, 24)}`;
}

async function emitDurableFetchReceipt(input: Parameters<typeof buildSourceRunReceipt>[0]): Promise<void> {
    await enqueueSourceRunReceipt(buildSourceRunReceipt(input));
}

// The fenced source-run path intentionally does not share legacy telemetry
// helpers. Its receipts are the authoritative lifecycle evidence; an enqueue
// acknowledgement or a legacy source_run row cannot close this unit.
async function processDurableFetch(job: Job<FetchJob>, jobLogger: ReturnType<typeof import('../observability/logger.js').createLogger>, signal?: AbortSignal): Promise<void> {
    const envelope = sourceRunExecutionEnvelopeSchema.parse(job.data.sourceRun);
    if (job.data.sourceId !== envelope.contentSourceId || job.data.tenantId !== envelope.tenantId || !job.data.sourceRunCoordinatorUnitId || !job.data.sourceRunPageId) {
        throw new Error('CMS source-run fetch payload does not match its fenced envelope');
    }
    const { sourceId, sourceType, config } = job.data;
    const pageId = job.data.sourceRunPageId;
    const settings = (config.settings as Record<string, unknown>) || {};
    const sourceConfig: SourceConfig = {
        id: sourceId, type: sourceType, name: (config.name as string) || sourceId,
        url: config.url as string, enabled: true, pollIntervalMs: (config.pollIntervalMs as number) || 300000,
        settings,
    };

    // This is immediately before provider I/O. A retry after this boundary is
    // verification/recovery work, never a blind second provider request.
    await cmsClient.beginSourceRunUnit({ tenantId: envelope.tenantId, requestId: envelope.sourceRunRequestId, attemptId: envelope.sourceRunAttemptId, unitId: envelope.executionUnitId, unitJobId: envelope.unitJobId, attemptFenceToken: envelope.attemptFenceToken, executionLeaseToken: envelope.executionLeaseToken }, job.id);
    const heartbeat = startSourceRunLeaseHeartbeat(envelope, { requestId: job.id });
    try {
    await emitDurableFetchReceipt({ envelope, stage: 'fetch', eventType: 'execution_started', outcome: 'no_change', sequence: 0, pageId, payload: { page_id: pageId } });
    await emitDurableFetchReceipt({ envelope, stage: 'fetch', eventType: 'provider_request_started', outcome: 'no_change', sequence: 1, pageId, payload: { source_id: sourceId, source_type: sourceType } });

    let result: Awaited<ReturnType<typeof fetchFromSource>>;
    try {
		heartbeat.assertCurrent();
        result = await fetchFromSource(sourceConfig, config.cursor as string | undefined, signal);
    } catch (error) {
        await cmsClient.freezeSourceRunPage({ tenantId: envelope.tenantId, requestId: envelope.sourceRunRequestId, attemptId: envelope.sourceRunAttemptId, unitId: envelope.executionUnitId, declaredChildCount: 0, declaredChildDigest: sourceRunManifestChildDigest([]) }, job.id);
        await emitDurableFetchReceipt({ envelope, stage: 'fetch', eventType: 'failed', outcome: 'provider_failed', sequence: 2, pageId, payload: { failure_class: 'provider_fetch_failed' } });
        throw error;
    }
	const observedBytes = Buffer.byteLength(JSON.stringify(result.items), 'utf8');
	const providerCallsSoFar = (getNonNegativeInteger(config.providerCallsSoFar) ?? 0) + 1;
	const observedBytesSoFar = (getNonNegativeInteger(config.observedBytesSoFar) ?? 0) + observedBytes;
	const configuredProviderCallCap = getPositiveInteger(settings.max_provider_calls);
	const configuredByteCap = getPositiveInteger(settings.max_bytes);

	const configuredMaxResults = getNonNegativeInteger(settings.max_results, settings.maxResults);
    const fetchedSoFar = getPositiveInteger(config.fetchedSoFar, 0) || 0;
	if (configuredMaxResults === 0) {
		heartbeat.assertCurrent();
		const capability = sourceObservationCapability(sourceType);
		let created = 0;
		if (capability && result.items.length > 0) {
			const recorded = await cmsClient.recordSourceRunUpstreamObservations({
				tenantId: envelope.tenantId, requestId: envelope.sourceRunRequestId,
				attemptId: envelope.sourceRunAttemptId, unitId: envelope.executionUnitId,
				unitJobId: envelope.unitJobId, attemptFenceToken: envelope.attemptFenceToken,
				executionLeaseToken: envelope.executionLeaseToken,
				providerCapability: capability, providerVersion: `${sourceType}:source-run-observation/v1`,
				providerPageId: pageId, providerCursor: result.cursor,
				items: result.items.slice(0, SOURCE_RUN_NORMALIZE_BATCH_SIZE).map((item) => ({
					upstreamItemId: item.externalId, upstreamFingerprint: upstreamItemFingerprint(item),
				})),
			}, job.id);
			created = recorded.created;
		}
		await cmsClient.freezeSourceRunPage({ tenantId: envelope.tenantId, requestId: envelope.sourceRunRequestId, attemptId: envelope.sourceRunAttemptId, unitId: envelope.executionUnitId, declaredChildCount: 0, declaredChildDigest: sourceRunManifestChildDigest([]) }, job.id);
		const outcome = result.items.length === 0
			? 'no_change'
			: capability
				? 'upstream_change_deferred'
				: 'observation_blocked_by_intake';
		const payload = { fetched: result.metadata.totalFetched, accepted: 0, observed: created, observed_bytes: observedBytes, provider_capability: capability ?? 'none', intake_capacity: 0, cursor_advanced: false };
		await emitDurableFetchReceipt({ envelope, stage: 'fetch', eventType: 'provider_page', outcome, sequence: 2, pageId, payload });
		await emitDurableFetchReceipt({ envelope, stage: 'fetch', eventType: 'provider_terminal', outcome, sequence: 3, pageId, finalPage: true, payload });
		jobLogger.info('CMS source-run observation completed without intake', { sourceId, pageId, outcome, observed: created });
		return;
	}
	const deferredObservationMap = parseDeferredObservationMap(settings.deferred_observation_map);
	const deferredItems = deferredObservationMap
		? result.items.filter((item) => deferredObservationMap.has(item.externalId))
		: result.items;
	const remaining = configuredMaxResults !== undefined ? Math.max(configuredMaxResults - fetchedSoFar, 0) : undefined;
	let items = remaining === undefined ? deferredItems : deferredItems.slice(0, remaining);
	if (configuredByteCap !== undefined) {
		const previousBytes = observedBytesSoFar - observedBytes;
		let acceptedBytes = 0;
		items = items.filter((item) => {
			const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
			if (previousBytes + acceptedBytes + bytes > configuredByteCap) return false;
			acceptedBytes += bytes;
			return true;
		});
	}
    const recovery = settings.recovery as { lookback_hours?: number; preserve_checkpoints?: boolean } | undefined;
    if (recovery?.preserve_checkpoints === true && recovery.lookback_hours) {
        const cutoff = Date.now() - Math.min(72, Math.max(1, recovery.lookback_hours)) * 60 * 60 * 1000;
        items = items.filter((item) => item.publishedAt && new Date(item.publishedAt).getTime() >= cutoff);
    }

    const normalizeQueue = getQueue(QUEUE_NAMES.NORMALIZE);
    const childKeys: string[] = [];
    if (items.length > 0 && !normalizeQueue) throw new Error('normalize queue is unavailable for source-run fetch page');
    for (let offset = 0, batchIndex = 0; offset < items.length; offset += SOURCE_RUN_NORMALIZE_BATCH_SIZE, batchIndex++) {
		heartbeat.assertCurrent();
        const batch = items.slice(offset, offset + SOURCE_RUN_NORMALIZE_BATCH_SIZE);
        const batchId = `batch-${batchIndex}`;
        const unitKey = `normalize:${pageId}:${batchId}`;
        const child = await cmsClient.authorizeSourceRunUnit({ tenantId: envelope.tenantId, requestId: envelope.sourceRunRequestId, attemptId: envelope.sourceRunAttemptId, parentUnitId: envelope.executionUnitId, unitType: 'normalize_batch', unitKey, pageId, batchId }, job.id);
        const lease = await cmsClient.acceptSourceRunUnit({ tenantId: envelope.tenantId, requestId: envelope.sourceRunRequestId, attemptId: envelope.sourceRunAttemptId, unitId: child.id, unitJobId: child.job_id, attemptFenceToken: child.attempt_fence_token }, job.id);
        const childEnvelope = durableEnvelope(envelope, child, lease);
        await normalizeQueue!.add('source-run-normalize-batch', {
            sourceId, sourceType,
            rawItems: batch.map((item) => ({ externalId: item.externalId, rawData: item, fetchedAt: item.fetchedAt, upstreamObservationId: deferredObservationMap?.get(item.externalId) })),
            fetchJobId: job.id || envelope.unitJobId, triggeredBy: 'schedule', sourceSettings: settings,
            sourceRunRequestId: envelope.sourceRunRequestId, tenantId: envelope.tenantId,
            sourceRun: childEnvelope, sourceRunPageId: pageId, sourceRunBatchId: batchId,
        }, { jobId: sourceRunQueueJobId(childEnvelope.unitJobId), priority: 1 });
        childKeys.push(unitKey);
    }

    const totalFetchedSoFar = fetchedSoFar + items.length;
    const reachedCap = configuredMaxResults !== undefined && totalFetchedSoFar >= configuredMaxResults;
	const reachedProviderCallCap = configuredProviderCallCap !== undefined && providerCallsSoFar >= configuredProviderCallCap;
	const reachedByteCap = configuredByteCap !== undefined && observedBytesSoFar >= configuredByteCap;
	const canContinue = !reachedCap && !reachedProviderCallCap && !reachedByteCap;
    if (result.hasMore && result.cursor && canContinue) {
		heartbeat.assertCurrent();
        const nextPageId = durablePageID(result.cursor);
        const next = await cmsClient.authorizeSourceRunUnit({ tenantId: envelope.tenantId, requestId: envelope.sourceRunRequestId, attemptId: envelope.sourceRunAttemptId, parentUnitId: job.data.sourceRunCoordinatorUnitId, unitType: 'fetch_page', unitKey: `fetch:${nextPageId}`, pageId: nextPageId }, job.id);
        const nextLease = await cmsClient.acceptSourceRunUnit({ tenantId: envelope.tenantId, requestId: envelope.sourceRunRequestId, attemptId: envelope.sourceRunAttemptId, unitId: next.id, unitJobId: next.job_id, attemptFenceToken: next.attempt_fence_token }, job.id);
        const nextEnvelope = durableEnvelope(envelope, next, nextLease);
        const fetchQueue = getQueue(QUEUE_NAMES.FETCH);
        if (!fetchQueue) throw new Error('fetch queue is unavailable for source-run continuation');
        await fetchQueue.add('source-run-fetch-page', { ...job.data, config: { ...config, cursor: result.cursor, fetchedSoFar: totalFetchedSoFar, providerCallsSoFar, observedBytesSoFar }, triggeredAt: new Date().toISOString(), sourceRun: nextEnvelope, sourceRunPageId: nextPageId }, { jobId: sourceRunQueueJobId(nextEnvelope.unitJobId), priority: 1, delay: 1000 });
    }

		heartbeat.assertCurrent();
    await cmsClient.freezeSourceRunPage({ tenantId: envelope.tenantId, requestId: envelope.sourceRunRequestId, attemptId: envelope.sourceRunAttemptId, unitId: envelope.executionUnitId, declaredChildCount: childKeys.length, declaredChildDigest: sourceRunManifestChildDigest(childKeys) }, job.id);
	const budgetTruncated = Boolean(result.hasMore && result.cursor && !canContinue);
	const deferredTargetMissing = Boolean(deferredObservationMap && items.length === 0 && !(result.hasMore && result.cursor && canContinue));
    const outcome = deferredTargetMissing || budgetTruncated ? 'partial' : items.length > 0 ? 'new_items' : 'no_change';
    await emitDurableFetchReceipt({ envelope, stage: 'fetch', eventType: 'provider_page', outcome, sequence: 2, pageId, payload: { fetched: result.metadata.totalFetched, accepted: items.length, observed_bytes: observedBytes, errors: result.metadata.errors, has_more: Boolean(result.hasMore && result.cursor && canContinue), budget_truncated: budgetTruncated, child_batches: childKeys.length } });
    await emitDurableFetchReceipt({ envelope, stage: 'fetch', eventType: 'provider_terminal', outcome, sequence: 3, pageId, finalPage: !(result.hasMore && result.cursor && canContinue), payload: { fetched: result.metadata.totalFetched, accepted: items.length, observed_bytes: observedBytes, errors: result.metadata.errors, next_cursor_present: Boolean(result.cursor && canContinue), budget_truncated: budgetTruncated } });
    jobLogger.info('CMS source-run fetch page completed', { sourceId, pageId, items: items.length, batches: childKeys.length });
	} finally {
		heartbeat.stop();
	}
}

function parseDeferredObservationMap(value: unknown): Map<string, string> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).filter(([upstreamId, observationId]) =>
		upstreamId.length > 0 && upstreamId.length <= 255 && typeof observationId === 'string' && /^[0-9a-f-]{36}$/i.test(observationId),
	);
	if (entries.length === 0 || entries.length > 20) throw new Error('CMS deferred observation map is outside its bounded contract');
	return new Map(entries as Array<[string, string]>);
}

export const createFetchWorker = () => createWorker({
    queueName: QUEUE_NAMES.FETCH,
    processor: async (job: Job<FetchJob>, jobLogger, signal): Promise<void> => {
		if (job.data.sourceRun) {
			return processDurableFetch(job, jobLogger, signal);
		}
        const { sourceId, sourceType, config, triggeredBy, triggeredAt, sourceRunRequestId, tenantId: jobTenantId, operatorPlanId, operatorStepId, idempotencyKey } = job.data;
        const startedAt = new Date();
        const sourceSettings = (config.settings as Record<string, unknown>) || {};
        const tenantId = jobTenantId || tenantFromSourceSettings(sourceSettings);

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

        // Compatibility requests carry explicit page/byte counters so a
		// Shorts-only listing cannot recurse forever while trying to fill the
		// accepted-item cap.
        let result: Awaited<ReturnType<typeof fetchFromSource>>;
		const previousProviderCalls = getNonNegativeInteger(job.data.providerCallsSoFar) ?? 0;
		const previousObservedBytes = getNonNegativeInteger(job.data.observedBytesSoFar) ?? 0;
        try {
            result = await fetchFromSource(sourceConfig, config.cursor as string | undefined, signal);
		} catch (error) {
			await reportFetchRun(tenantId, sourceId, sourceRunRequestId, job.id, triggeredBy, startedAt, 0, 1, {
				sourceType, recovery: sourceSettings.recovery,
				error: error instanceof Error ? error.message : String(error),
			}, { terminal: true, hasMore: false, outcome: 'provider_failure', providerCalls: previousProviderCalls + 1, observedBytes: previousObservedBytes }, signal);
            throw error;
        }
		const providerCalls = previousProviderCalls + 1;
		const observedBytes = previousObservedBytes + Buffer.byteLength(JSON.stringify(result.items), 'utf8');
		const providerCallCap = getPositiveInteger(sourceSettings.max_provider_calls) ?? 8;
		const byteCap = getPositiveInteger(sourceSettings.max_bytes) ?? 64 * 1024 * 1024;

        const remainingAllowed =
            typeof configuredMaxResults === 'number' && configuredMaxResults > 0
                ? Math.max(configuredMaxResults - fetchedSoFar, 0)
                : undefined;

        let itemsForThisRun =
            typeof remainingAllowed === 'number'
                ? result.items.slice(0, remainingAllowed)
                : result.items;
		const recovery = sourceSettings.recovery as { lookback_hours?: number; preserve_checkpoints?: boolean } | undefined;
		if (recovery?.preserve_checkpoints === true && recovery.lookback_hours) {
			const cutoff = Date.now() - Math.min(72, Math.max(1, recovery.lookback_hours)) * 60 * 60 * 1000;
			itemsForThisRun = itemsForThisRun.filter(item => {
				if (!item.publishedAt) return false;
				const publishedAt = new Date(item.publishedAt).getTime();
				return Number.isFinite(publishedAt) && publishedAt >= cutoff;
			});
		}

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
		const reachedProviderCallCap = providerCalls >= providerCallCap;
		const reachedByteCap = observedBytes >= byteCap;
		const canContinue = Boolean(result.hasMore && result.cursor && !reachedMaxResults && !reachedProviderCallCap && !reachedByteCap);

        // If we got items, enqueue normalize job
        if (itemsForThisRun.length > 0) {
            const normalizeQueue = getQueue(QUEUE_NAMES.NORMALIZE);
			if (!normalizeQueue) {
				await reportFetchRun(tenantId, sourceId, sourceRunRequestId, job.id, triggeredBy, startedAt, result.metadata.totalFetched, 1, {
					sourceType, recovery: sourceSettings.recovery, reason: 'normalize_queue_unavailable',
				}, { terminal: true, hasMore: false, outcome: 'downstream_unavailable', providerCalls, observedBytes, accepted: 0, filtered: result.metadata.skipped }, signal);
				throw new Error('normalize queue is unavailable for compatibility fetch');
			}

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
						sourceRunRequestId,
						tenantId,
						operatorPlanId,
						operatorStepId,
						idempotencyKey,
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
        if (canContinue) {
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
						sourceRunRequestId,
						tenantId,
						operatorPlanId,
						operatorStepId,
						idempotencyKey,
						providerCallsSoFar: providerCalls,
						observedBytesSoFar: observedBytes,
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
        } else if (result.hasMore && result.cursor) {
			jobLogger.info('Reached compatibility fetch budget, stopping pagination', {
                sourceId,
                sourceType,
                fetchedSoFar: totalFetchedSoFar,
                configuredMaxResults,
				providerCalls,
				providerCallCap,
				observedBytes,
				byteCap,
            });
        }

		const terminal = !canContinue;
		const budgetTruncated = Boolean(result.hasMore && result.cursor && terminal);
		const outcome = result.metadata.errors > 0 && itemsForThisRun.length === 0
			? 'provider_failure'
			: budgetTruncated
				? 'budget_truncated'
				: itemsForThisRun.length > 0
					? 'legal_candidates'
					: result.metadata.skipped > 0
						? 'filtered_short_or_invalid'
						: 'no_change';
		await reportFetchRun(tenantId, sourceId, sourceRunRequestId, job.id, triggeredBy, startedAt, result.metadata.totalFetched, result.metadata.errors, {
			sourceType, recovery: sourceSettings.recovery, reason: result.metadata.reason,
		}, { terminal, hasMore: canContinue, outcome, providerCalls, observedBytes, accepted: itemsForThisRun.length, filtered: result.metadata.skipped }, signal);
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

function getNonNegativeInteger(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
	}
	return undefined;
}

function sourceObservationCapability(sourceType: string): 'replayable_listing' | 'peek' | undefined {
	sourceType = sourceType.toLowerCase();
	if (['rss', 'podcast', 'youtube', 'reddit'].includes(sourceType)) return 'replayable_listing';
	if (['twitter', 'telegram', 'website'].includes(sourceType)) return 'peek';
	return undefined;
}

function upstreamItemFingerprint(item: RawFetchedItem): string {
	return createHash('sha256').update(JSON.stringify({ external_id: item.externalId, url: item.url, published_at: item.publishedAt ?? null, source_type: item.sourceType }), 'utf8').digest('hex');
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
	sourceRunRequestId: string | undefined,
    jobId: string | undefined,
    triggeredBy: 'schedule' | 'manual',
    startedAt: Date,
    fetched: number,
    failed: number,
    metadata: Record<string, unknown>,
	outcome: { terminal: boolean; hasMore: boolean; outcome: string; providerCalls: number; observedBytes: number; accepted?: number; filtered?: number },
    signal?: AbortSignal,
): Promise<void> {
    if (!jobId || !isUuid(sourceId)) return;
    const finishedAt = new Date();
    try {
        await cmsClient.reportSourceRun({
            tenant_id: tenantId,
            source_id: sourceId,
			source_run_request_id: sourceRunRequestId,
            job_id: jobId,
            triggered_by: triggeredBy,
            fetched,
			accepted: outcome.accepted ?? 0,
			filtered: outcome.filtered ?? 0,
            failed,
			terminal: outcome.terminal,
			has_more: outcome.hasMore,
			outcome: outcome.outcome,
			provider_calls: outcome.providerCalls,
			observed_bytes: outcome.observedBytes,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - startedAt.getTime(),
			metadata: { ...metadata, stage: 'fetch' },
        }, jobId, signal);
    } catch {
        // Telemetry must never fail ingestion.
    }
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
