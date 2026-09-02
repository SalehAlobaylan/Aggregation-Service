/**
 * Embedding Reconciliation Sweep Worker (H2 backstop)
 *
 * READY content can be marked READY only once its embedding persisted (the AI
 * worker gates on this). This sweep is the safety net: it periodically asks CMS
 * for any READY item STILL missing a dense embedding — items whose original AI
 * job exhausted its retries, plus historical rows from before the gate existed —
 * and re-enqueues an *embedding-only* AI job for each (never re-transcribes).
 *
 * Repeatable job scheduled by `syncReconcileSweeper()` on startup, interval +
 * batch size from config (RECONCILE_*).
 */
import { Job, Queue } from 'bullmq';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type AIJob, type ReconcileJob } from '../queues/index.js';
import { getQueue } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { deleteObject, getObjectMetadata, type StorageTier } from '../storage/client.js';

async function reconcileUncertainArtifactManifests(requestId?: string): Promise<{ adopted: number; failed: number; deleted: number }> {
    const { manifests } = await cmsClient.listArtifactManifests({
        state: 'uploading,uploaded,uncertain',
        stale: true,
    }, requestId);
    const result = { adopted: 0, failed: 0, deleted: 0 };
    for (const manifest of manifests) {
        const tier = manifest.storage_tier === 'cold' ? 'cold' : 'primary';
        const metadata = await getObjectMetadata(manifest.object_key, tier as StorageTier);
        const correlation = {
            tenant_id: manifest.tenant_id,
            producer_event_id: manifest.producer_event_id,
            fence_token: manifest.fence_token ?? undefined,
        };
        if (!metadata.exists) {
            await cmsClient.transitionArtifactManifest(manifest.id, 'failed', {
                ...correlation,
                terminal_proof: { reconciled: true, object_present: false },
            }, requestId);
            result.failed += 1;
            continue;
        }
        const sizeMatches = manifest.size_bytes <= 0 || metadata.size === manifest.size_bytes;
        const typeMatches = !manifest.content_type || !metadata.contentType || metadata.contentType === manifest.content_type;
        if (!sizeMatches || !typeMatches) {
            // Delete first while the manifest remains retryable. If provider
            // deletion fails, the next reconciliation sweep still sees the
            // uncertain/uploaded row; moving it to cleanup_eligible first
            // would strand an object because that state is intentionally not
            // part of the uncertain-manifest claim.
            await deleteObject(manifest.object_key, tier as StorageTier);
            await cmsClient.transitionArtifactManifest(manifest.id, 'cleanup_eligible', {
                ...correlation,
                cleanup_after_sec: 0,
                terminal_proof: {
                    reconciled: true,
                    reason: 'provider_metadata_mismatch',
                    expected_size: manifest.size_bytes,
                    observed_size: metadata.size,
                    expected_content_type: manifest.content_type,
                    observed_content_type: metadata.contentType,
                },
            }, requestId);
            await cmsClient.transitionArtifactManifest(manifest.id, 'deleted', correlation, requestId);
            result.deleted += 1;
            continue;
        }
        if (manifest.state === 'uploading') {
            await cmsClient.transitionArtifactManifest(manifest.id, 'uploaded', {
                ...correlation,
                size_bytes: metadata.size,
                etag: metadata.etag,
                public_url: manifest.public_url,
            }, requestId);
        }
        await cmsClient.transitionArtifactManifest(manifest.id, 'verified', {
            ...correlation,
            size_bytes: metadata.size,
            etag: metadata.etag,
            content_type: metadata.contentType ?? manifest.content_type,
            verification_evidence: { reconciled: true, provider_head_verified: true },
        }, requestId);
        result.adopted += 1;
    }
    return result;
}

export const createReconcileWorker = () => createWorker({
    queueName: QUEUE_NAMES.RECONCILE,
    concurrency: 1,
    processor: async (job: Job<ReconcileJob>, jobLogger): Promise<void> => {
        try {
            const manifests = await reconcileUncertainArtifactManifests(job.id);
            if (manifests.adopted || manifests.failed || manifests.deleted) {
                jobLogger.info('Reconciled uncertain artifact manifests', manifests);
            }
        } catch (error) {
            jobLogger.warn('Artifact-manifest reconciliation deferred', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        // First repair lifecycle contradictions locally. A late Enrichment
        // writeback must not be followed by a second model invocation merely
        // because the compatibility AI worker timed out.
        try {
            const statusRepair = await cmsClient.reconcileArtifactCompleteStatuses(config.reconcileBatch, job.id);
            if (statusRepair.reconciled > 0) {
                jobLogger.info('Reconciled artifact-complete FAILED items without re-enrichment', statusRepair);
            }
        } catch (error) {
            jobLogger.warn('Artifact-complete lifecycle reconciliation deferred', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        const { items } = await cmsClient.listMissingEmbedding(config.reconcileBatch, job.id);

        if (items.length === 0) {
            jobLogger.debug('Reconcile tick: no READY items missing an embedding');
            return;
        }

        const aiQueue = getQueue(QUEUE_NAMES.AI);
        if (!aiQueue) {
            jobLogger.warn('Reconcile tick: AI queue not initialized; skipping');
            return;
        }

        let enqueued = 0;
        for (const item of items) {
            const aiJob: AIJob = {
                contentItemId: item.id,
                contentType: item.type as AIJob['contentType'],
                operations: ['embedding'], // embedding-only — no re-transcribe
                textContent: {
                    title: item.title || '',
                    excerpt: item.excerpt || undefined,
                    bodyText: item.body_text || undefined,
                },
            };
            const jobId = `reconcile-embed-${item.id}`;

            // Deterministic jobIds dedup against ACTIVE work, but BullMQ also
            // silently ignores an add while a finished job with the same id is
            // still retained — a single failure (e.g. Enrichment cold start)
            // would wedge the item for the whole removeOnFail window with every
            // sweep no-oping. Clear finished remnants so the sweep can retry;
            // leave queued/active jobs alone (genuine dedup).
            const existing = await aiQueue.getJob(jobId);
            if (existing) {
                const state = await existing.getState();
                if (state === 'failed' || state === 'completed') {
                    await existing.remove();
                } else {
                    continue; // still queued/active — let it run
                }
            }

            await aiQueue.add(`reconcile-embed-${item.id}`, aiJob, {
                priority: 5, // below fresh ingestion
                jobId,
                removeOnComplete: { age: 3600, count: 200 },
                removeOnFail: { age: 86400 },
            });
            enqueued++;
        }

        jobLogger.info('Reconcile sweep enqueued embedding-only jobs', {
            found: items.length,
            enqueued,
        });
    },
});

const REPEATABLE_NAME = 'embedding-reconcile-auto';

/**
 * Register (or clear) the repeatable reconciliation sweep based on config.
 * Best-effort — call on startup; non-fatal if Redis/queue isn't ready.
 */
export async function syncReconcileSweeper(): Promise<void> {
    const queue = getQueue(QUEUE_NAMES.RECONCILE) as Queue | undefined;
    if (!queue) {
        logger.warn('reconcile worker: queue not initialized; skipping sync');
        return;
    }

    // Clear any existing repeatable(s) then re-register from current config.
    const existing = await queue.getRepeatableJobs();
    for (const j of existing) {
        if (j.name.startsWith(REPEATABLE_NAME)) {
            await queue.removeRepeatableByKey(j.key);
        }
    }

    if (!config.reconcileEnabled) {
        logger.info('reconcile worker: disabled (RECONCILE_ENABLED=false)');
        return;
    }

    await queue.add(
        REPEATABLE_NAME,
        { trigger: 'auto' } as ReconcileJob,
        {
            repeat: { every: config.reconcileIntervalMs },
            removeOnComplete: { age: 3600, count: 50 },
            removeOnFail: { age: 86400 },
        }
    );
    logger.info('reconcile worker: registered repeatable embedding sweep', {
        intervalMs: config.reconcileIntervalMs,
        batch: config.reconcileBatch,
    });
}
