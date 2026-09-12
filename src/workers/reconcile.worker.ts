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
import { getObjectMetadata, readObjectDigest, type StorageTier } from '../storage/client.js';

async function reconcileUncertainArtifactManifests(requestId?: string): Promise<{ adopted: number; failed: number; deleted: number }> {
    const result = { adopted: 0, failed: 0, deleted: 0 };
    // Atomization units have a nested, renewable lease.  Once that lease is
    // expired, waiting for the broad source-artifact quarantine window makes
    // a sequential Pods episode look permanently stuck after a worker crash.
    // Reconcile those manifests on the next sweep, while retaining the longer
    // observation window for legacy/source artifacts below.
    const lists = await Promise.all([
        cmsClient.listArtifactManifests({
            state: 'uploading,uploaded,uncertain',
            stale: true,
            atomization: true,
        }, requestId),
        cmsClient.listArtifactManifests({
            state: 'uploading,uploaded,uncertain',
            stale: true,
        }, requestId),
    ]);
    const seen = new Set<string>();
    const manifests = lists.flatMap(({ manifests: rows }) => rows).filter((manifest) => {
        if (seen.has(manifest.id)) return false;
        seen.add(manifest.id);
        return true;
    });
    for (const manifest of manifests) {
      try {
        const credentialed = await cmsClient.getArtifactManifest(manifest.id, requestId, undefined, true);
        if (!credentialed.fence_token) {
            logger.warn('Artifact credential projection was incomplete; reconciliation withheld', { manifestId: manifest.id });
            continue;
        }
        const tier = manifest.storage_tier === 'cold' ? 'cold' : 'primary';
        const configuredBucket = tier === 'cold' ? (config.coldStorageBucket ?? config.storageBucket) : config.storageBucket;
        if (manifest.bucket !== configuredBucket) {
            logger.warn('Artifact belongs to a different configured bucket; reconciliation withheld', { manifestId: manifest.id, bucket: manifest.bucket });
            continue;
        }
        const metadata = await getObjectMetadata(manifest.object_key, tier as StorageTier);
        const correlation = {
            tenant_id: manifest.tenant_id,
            producer_event_id: manifest.producer_event_id,
            fence_token: credentialed.fence_token,
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
            logger.warn('Conflicting artifact retained for operator reconciliation', { manifestId: manifest.id });
            continue;
        }
        let observedChecksum = metadata.checksumSha256;
        if (manifest.atomization_chapter_unit_id || manifest.attempt_id) {
            if (!manifest.sha256 || manifest.size_bytes <= 0) {
                logger.warn('Artifact has no immutable digest; operator reconciliation required', { manifestId: manifest.id });
                continue;
            }
            // R2 may not return native SHA256 on HEAD. Hash a bounded stream,
            // never download to scratch, recut, overwrite or delete the object.
            const observed = await readObjectDigest(manifest.object_key, manifest.size_bytes, tier, AbortSignal.timeout(300_000));
            if (observed.bytes !== manifest.size_bytes || observed.sha256 !== manifest.sha256) {
                logger.warn('Artifact checksum conflict retained for inspection', { manifestId: manifest.id });
                continue;
            }
            observedChecksum = observed.sha256;
        }
        await cmsClient.transitionArtifactManifest(manifest.id, 'verified', {
            ...correlation,
            size_bytes: metadata.size,
            etag: metadata.etag,
            content_type: metadata.contentType ?? manifest.content_type,
            verification_evidence: { reconciled: true, provider_head_verified: true, provider_checksum_sha256: observedChecksum },
        }, requestId);
        result.adopted += 1;
      } catch (error) {
        logger.warn('Artifact observation deferred without changing objects', { manifestId: manifest.id, error: error instanceof Error ? error.message : String(error) });
      }
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
