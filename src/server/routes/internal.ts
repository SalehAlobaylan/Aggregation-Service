/**
 * Internal service-to-service routes. Used by CMS to hand off user-submitted
 * content into the same normalize → media → AI pipeline as ingested content.
 */
import type { FastifyInstance } from 'fastify';
import { createWriteStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';
import {
    getQueue,
    QUEUE_NAMES,
    type ContentType,
    type DiscoverySweepJob,
    type MediaJob,
    type NewsCirculationJob,
    type SourceGraphJob,
} from '../../queues/index.js';
import { enqueueRetryJob } from '../../queues/retry-routing.js';
import { deleteContentObjects, deleteContentObjectsExact, deleteObject, getStorageKey, objectExists, readObjectBuffer, recoveryArtifactEncryptionVerified, uploadEncryptedRecoveryArtifact, uploadFile } from '../../storage/client.js';
import { logger } from '../../observability/logger.js';
import { verifyInternalServiceAuth } from '../plugins/internal-auth.js';
import { cmsClient } from '../../cms/client.js';
import { preflightCheck, resolveIngestProfile } from '../../services/quality.service.js';
import { runSweepForTenant } from '../../services/storage.service.js';

interface UserContentResponse {
    success: boolean;
    contentItemId?: string;
    jobId?: string;
    accepted?: boolean;
    alreadyAccepted?: boolean;
    message?: string;
}

interface InternalQueueStats {
    queue: string;
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
}

interface InternalRetryBody {
    ids?: string[];
    source?: string;
    limit?: number;
}

interface InternalRetryResponse {
    success: boolean;
    message: string;
    requeued: number;
    total: number;
    errors: string[];
}

const USER_CONTENT_MAX_BYTES = 200 * 1024 * 1024;
const USER_CONTENT_MAX_CONCURRENT_ADMISSIONS = 2;
const USER_CONTENT_PREFIX_BYTES = 64;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
const RECOVERY_ARTIFACT_PREFIX = /^system\/recovery\/[a-z0-9_-]{1,64}\/[0-9a-f-]{36}\/[a-f0-9]{64}\.json\.gz$/;
let activeUserContentAdmissions = 0;

function validRecoveryArtifactRef(key: string, checksum: string): boolean {
	return RECOVERY_ARTIFACT_PREFIX.test(key) && /^[a-f0-9]{64}$/.test(checksum) && key.endsWith(`/${checksum}.json.gz`);
}

type UserAudioFormat = { extension: 'mp3' | 'wav' | 'm4a'; mimeType: string };

function detectUserAudioFormat(prefix: Buffer): UserAudioFormat | null {
    if (prefix.length >= 3 && prefix.subarray(0, 3).toString('ascii') === 'ID3') {
        return { extension: 'mp3', mimeType: 'audio/mpeg' };
    }
    if (prefix.length >= 2 && prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0) {
        return { extension: 'mp3', mimeType: 'audio/mpeg' };
    }
    if (prefix.length >= 12 && prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WAVE') {
        return { extension: 'wav', mimeType: 'audio/wav' };
    }
    if (prefix.length >= 8 && prefix.subarray(4, 8).toString('ascii') === 'ftyp') {
        return { extension: 'm4a', mimeType: 'audio/mp4' };
    }
    return null;
}

async function spoolUserAudio(file: NodeJS.ReadableStream): Promise<{ directory: string; path: string; byteCount: number; format: UserAudioFormat }> {
    const directory = await mkdtemp(join(tmpdir(), 'wahb-user-content-'));
    const path = join(directory, 'upload');
    let byteCount = 0;
    const prefix: Buffer[] = [];
    let prefixLength = 0;
    const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            byteCount += chunk.length;
            if (byteCount > USER_CONTENT_MAX_BYTES) {
                callback(new Error('user content exceeds byte limit'));
                return;
            }
            if (prefixLength < USER_CONTENT_PREFIX_BYTES) {
                const remaining = USER_CONTENT_PREFIX_BYTES - prefixLength;
                const copied = chunk.subarray(0, remaining);
                prefix.push(copied);
                prefixLength += copied.length;
            }
            callback(null, chunk);
        },
    });
    try {
        await pipeline(file, counter, createWriteStream(path, { flags: 'wx' }));
        if (byteCount === 0) throw new Error('user content is empty');
        const format = detectUserAudioFormat(Buffer.concat(prefix, prefixLength));
        if (!format) throw new Error('user content is not an allowed audio container');
        return { directory, path, byteCount, format };
    } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

export async function internalRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.addHook('onRequest', verifyInternalServiceAuth);

    fastify.get<{ Reply: { data: InternalQueueStats[] } }>('/internal/queues', async (_request, reply) => {
        const data: InternalQueueStats[] = [];
        for (const queueName of Object.values(QUEUE_NAMES)) {
            const queue = getQueue(queueName);
            if (!queue) continue;
            const counts = await queue.getJobCounts();
            data.push({
                queue: queueName,
                waiting: counts.waiting || 0,
                active: counts.active || 0,
                completed: counts.completed || 0,
                failed: counts.failed || 0,
                delayed: counts.delayed || 0,
            });
        }
        return reply.send({ data });
    });

	// Recovery artifacts are a deliberately narrow object-store capability for
	// CMS Retention. The request supplies neither a bucket nor arbitrary key;
	// only reserved, content-addressed system/recovery objects are accepted.
	fastify.post<{ Body: { key?: string; sha256?: string; payload_base64?: string } }>(
		'/internal/recovery-artifacts',
		{ bodyLimit: 48 * 1024 * 1024 },
		async (request, reply) => {
			const key = String(request.body?.key ?? '');
			const checksum = String(request.body?.sha256 ?? '').toLowerCase();
			const encoded = String(request.body?.payload_base64 ?? '');
			if (!validRecoveryArtifactRef(key, checksum) || encoded.length === 0) {
				return reply.status(400).send({ message: 'invalid recovery artifact request' });
			}
			let body: Buffer;
			try { body = Buffer.from(encoded, 'base64'); } catch { return reply.status(400).send({ message: 'invalid recovery artifact payload' }); }
			if (body.length === 0 || body.length > RECOVERY_ARTIFACT_MAX_BYTES || createHash('sha256').update(body).digest('hex') !== checksum) {
				return reply.status(400).send({ message: 'recovery artifact checksum or size rejected' });
			}
			try {
				if (await objectExists(key)) {
					const existing = await readObjectBuffer(key, RECOVERY_ARTIFACT_MAX_BYTES);
					if (createHash('sha256').update(existing).digest('hex') !== checksum) return reply.status(409).send({ message: 'recovery key already has different content' });
				} else {
					await uploadEncryptedRecoveryArtifact(key, body);
				}
				if (!await recoveryArtifactEncryptionVerified(key)) return reply.status(409).send({ message: 'recovery artifact encryption could not be verified' });
				const readback = await readObjectBuffer(key, RECOVERY_ARTIFACT_MAX_BYTES);
				if (createHash('sha256').update(readback).digest('hex') !== checksum) return reply.status(502).send({ message: 'recovery artifact readback mismatch' });
				return reply.send({ data: { key, sha256: checksum, bytes: body.length, verified: true } });
			} catch (error) {
				logger.warn('Recovery artifact operation failed', { key, error: error instanceof Error ? error.message : 'unknown' });
				return reply.status(502).send({ message: 'recovery artifact storage unavailable' });
			}
		},
	);

	fastify.post<{ Body: { key?: string; sha256?: string } }>('/internal/recovery-artifacts/verify', async (request, reply) => {
		const key = String(request.body?.key ?? ''); const checksum = String(request.body?.sha256 ?? '').toLowerCase();
		if (!validRecoveryArtifactRef(key, checksum)) return reply.status(400).send({ message: 'invalid recovery artifact reference' });
		try {
			const body = await readObjectBuffer(key, RECOVERY_ARTIFACT_MAX_BYTES);
			const verified = createHash('sha256').update(body).digest('hex') === checksum && await recoveryArtifactEncryptionVerified(key);
			return reply.status(verified ? 200 : 409).send({ data: { key, sha256: checksum, bytes: body.length, verified } });
		} catch { return reply.status(502).send({ message: 'recovery artifact unavailable' }); }
	});

	fastify.delete<{ Body: { key?: string } }>('/internal/recovery-artifacts', async (request, reply) => {
		const key = String(request.body?.key ?? '');
		if (!RECOVERY_ARTIFACT_PREFIX.test(key)) return reply.status(400).send({ message: 'invalid recovery artifact reference' });
		try {
			await deleteObject(key);
			return reply.send({ data: { key, deleted: true } });
		} catch { return reply.status(502).send({ message: 'recovery artifact deletion unavailable' }); }
	});

	fastify.post<{ Body: { run_id?: string; tenant_id?: string; lane?: 'news' | 'media'; source_ids?: string[]; lookback_hours?: number; max_items?: number; manifest_hash?: string; idempotency_key?: string; preserve_checkpoints?: boolean; fencing_token?: string } }>('/internal/recovery/reseed', async (request, reply) => {
		const body = request.body ?? {};
		const lane = body.lane;
		const sourceIds = Array.isArray(body.source_ids) ? body.source_ids.filter(value => CANONICAL_UUID.test(String(value))) : [];
		const maxItems = Number(body.max_items ?? 0);
		const lookbackHours = Number(body.lookback_hours ?? 0);
		if (!body.run_id || !body.tenant_id || (lane !== 'news' && lane !== 'media') || sourceIds.length === 0 || sourceIds.length > 200 || !body.manifest_hash || !body.idempotency_key || !body.fencing_token || !CANONICAL_UUID.test(String(body.fencing_token)) || body.preserve_checkpoints !== true || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 500 || !Number.isInteger(lookbackHours) || lookbackHours < 1 || lookbackHours > 72) {
			return reply.status(400).send({ message: 'invalid bounded recovery reseed request' });
		}
		const queue = getQueue(QUEUE_NAMES.NEWS_CIRCULATION);
		if (!queue) return reply.status(503).send({ message: 'recovery reseed queue unavailable' });
		const job = await queue.add('recovery-reseed-' + lane, { trigger: 'manual', tenantId: body.tenant_id, recovery: { runId: body.run_id, manifestHash: body.manifest_hash, lane, sourceIds, lookbackHours, maxItems, preserveCheckpoints: true } } satisfies NewsCirculationJob, { priority: 1, jobId: body.idempotency_key });
		return reply.send({ data: { queued: true, job_id: job.id ?? body.idempotency_key, lane, checkpoint_mode: 'preserve', lookback_hours: lookbackHours, max_items: maxItems, fencing_token: body.fencing_token } });
	});

	fastify.post<{ Body: { run_id?: string; tenant_id?: string; content_ids?: string[]; saga_items?: Array<{ id?: string; provider_objects?: string[]; no_full_rollback?: boolean }>; manifest_hash?: string; idempotency_key?: string; item_idempotency_keys?: Record<string, string>; fencing_token?: string } }>('/internal/recovery/purge-media', async (request, reply) => {
		const body = request.body ?? {};
		const ids = Array.isArray(body.content_ids) ? body.content_ids.filter(value => CANONICAL_UUID.test(String(value))) : [];
		const sagaItems = Array.isArray(body.saga_items) ? body.saga_items : [];
		const sagaIDs = sagaItems.map(item => String(item.id ?? '')).filter(value => CANONICAL_UUID.test(value));
		const itemKeys = body.item_idempotency_keys ?? {};
		if (!body.run_id || !body.tenant_id || !body.manifest_hash || !body.idempotency_key || !body.fencing_token || !CANONICAL_UUID.test(String(body.fencing_token)) || ids.length > 30 || ids.length === 0 || sagaItems.length !== ids.length || sagaIDs.some(id => !ids.includes(id)) || ids.some(id => !String(itemKeys[id] ?? '').trim())) return reply.status(400).send({ message: 'invalid exact media purge saga request' });
		let deletedCount = 0;
		let freedBytes = 0;
		const errors: string[] = [];
		const results: Array<{ id: string; deleted_count: number; freed_bytes: number; objects_absent: boolean; request_id: string; result_hash: string; error?: string }> = [];
		for (const id of ids) {
			const requestId = String(itemKeys[id]);
			try {
				const item = await cmsClient.getContentItem(id);
				if (item.tenant_id !== body.tenant_id) { const error = 'tenant mismatch'; errors.push(`${id}: ${error}`); results.push({ id, deleted_count: 0, freed_bytes: 0, objects_absent: false, request_id: requestId, result_hash: createHash('sha256').update(`${body.manifest_hash}|${requestId}|${error}`).digest('hex'), error }); continue; }
				if ((item.type !== 'VIDEO' && item.type !== 'PODCAST') || item.status !== 'READY' || item.is_feed_unit !== true || item.feed_visibility !== 'visible') {
					const error = 'media manifest no longer matches a visible READY feed unit';
					errors.push(`${id}: ${error}`); results.push({ id, deleted_count: 0, freed_bytes: 0, objects_absent: false, request_id: requestId, result_hash: createHash('sha256').update(`${body.manifest_hash}|${requestId}|${error}`).digest('hex'), error });
					continue;
				}
				const sagaItem = sagaItems.find(item => String(item.id) === id);
				const objectRefs = Array.isArray(sagaItem?.provider_objects) ? sagaItem.provider_objects.map(value => String(value).trim()).filter(Boolean) : [];
				if (objectRefs.length === 0 && sagaItem?.no_full_rollback !== true) {
					const error = 'exact provider object map is required';
					errors.push(`${id}: ${error}`); results.push({ id, deleted_count: 0, freed_bytes: 0, objects_absent: false, request_id: requestId, result_hash: createHash('sha256').update(`${body.manifest_hash}|${requestId}|${error}`).digest('hex'), error });
					continue;
				}
				const result = objectRefs.length > 0 ? await deleteContentObjectsExact(id, objectRefs) : await deleteContentObjects(id);
				deletedCount += result.deletedCount;
				freedBytes += result.freedBytes;
				const resultHash = createHash('sha256').update(`${body.manifest_hash}|${requestId}|${result.deletedCount}|${result.freedBytes}|${result.objectsAbsent}`).digest('hex');
				results.push({ id, deleted_count: result.deletedCount, freed_bytes: result.freedBytes, objects_absent: result.objectsAbsent, request_id: requestId, result_hash: resultHash });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push(`${id}: ${message}`); results.push({ id, deleted_count: 0, freed_bytes: 0, objects_absent: false, request_id: requestId, result_hash: createHash('sha256').update(`${body.manifest_hash}|${requestId}|${message}`).digest('hex'), error: message });
			}
		}
		const resultRoot = createHash('sha256').update(results.map(row => row.result_hash).sort().join('|')).digest('hex');
		if (errors.length > 0) return reply.status(409).send({ message: 'media recovery purge was partial', data: { deleted_count: deletedCount, freed_bytes: freedBytes, errors, results, result_root: resultRoot, fencing_token: body.fencing_token } });
		return reply.send({ data: { deleted_count: deletedCount, freed_bytes: freedBytes, errors: [], results, result_root: resultRoot, fencing_token: body.fencing_token } });
	});

	// Retention can request one bounded Storage-owner run. This endpoint does
	// not accept candidate IDs: Storage reloads its policy and selects/rechecks
	// its own candidates through CMS, preserving its single ownership boundary.
	fastify.post<{ Body: { tenant_id?: string; owner?: string; action_class?: string; allowed_action_classes?: string[]; max_bytes?: number; max_items?: number; max_actions?: number; expires_at?: string; idempotency_key?: string; manifest_hash?: string; correlation_id?: string; owner_request_id?: string } }>('/internal/retention/storage/sweep', async (request, reply) => {
		const tenantId = String(request.body?.tenant_id ?? '').trim();
		const owner = String(request.body?.owner ?? '');
		const actionClass = String(request.body?.action_class ?? '');
		const allowedClasses = Array.isArray(request.body?.allowed_action_classes) ? request.body?.allowed_action_classes.map(String) : [];
		const expiresAt = Date.parse(String(request.body?.expires_at ?? ''));
		if (!tenantId || owner !== 'storage' || actionClass !== 'storage.request_bounded_run' || !allowedClasses.includes(actionClass) || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || !String(request.body?.idempotency_key ?? '').trim() || !String(request.body?.manifest_hash ?? '').trim()) return reply.status(400).send({ message: 'complete non-expired owner envelope is required' });
		try {
			const policies = await cmsClient.listStoragePolicies();
			const policy = policies.all.find(row => row.tenant_id === tenantId) ?? policies.global;
			if (!policy) return reply.status(404).send({ message: 'storage policy not found' });
			const result = await runSweepForTenant({ ...policy, tenant_id: tenantId }, 'retention', {
				maxBytes: Math.max(0, Number(request.body?.max_bytes ?? 0)) || undefined,
				archiveAction: policy.archive_action === 'move_to_cold' ? 'move_to_cold' : 're_encode',
				idempotencyKey: String(request.body?.idempotency_key),
				manifestHash: String(request.body?.manifest_hash ?? '') || undefined,
				correlationId: String(request.body?.correlation_id ?? '') || undefined,
				ownerRequestId: String(request.body?.owner_request_id ?? '') || undefined,
			});
			const requestedMaxBytes = Number(request.body?.max_bytes ?? 0);
			const actionCount = Number(result.deletedCount ?? 0) + Number(result.movedToColdCount ?? 0) + Number(result.reEncodedCount ?? 0);
			const requestedMaxActions = Number(request.body?.max_actions ?? 0);
			if (requestedMaxBytes > 0 && result.freedBytes > requestedMaxBytes) {
				return reply.status(409).send({ message: 'storage owner exceeded the approved byte bound', freed_bytes: result.freedBytes, max_bytes: requestedMaxBytes });
			}
			if (requestedMaxActions > 0 && actionCount > requestedMaxActions) {
				return reply.status(409).send({ message: 'storage owner exceeded the approved action bound', action_count: actionCount, max_actions: requestedMaxActions });
			}
			const requestedMaxItems = Number(request.body?.max_items ?? 0);
			if (requestedMaxItems > 0 && actionCount > requestedMaxItems) {
				return reply.status(409).send({ message: 'storage owner exceeded the approved item bound', action_count: actionCount, max_items: requestedMaxItems });
			}
			const resultHash = createHash('sha256').update(`${request.body?.manifest_hash}|${tenantId}|${result.deletedCount}|${result.freedBytes}|${actionCount}|${request.body?.owner_request_id ?? ''}`).digest('hex');
			return reply.send({ data: { ...result, owner, action_class: actionClass, action_count: actionCount, request_hash: request.body?.manifest_hash, owner_request_id: request.body?.owner_request_id, result_hash: resultHash } });
		} catch (error) {
			logger.warn('Retention Storage owner request failed', { error: error instanceof Error ? error.message : 'unknown' });
			return reply.status(502).send({ message: 'storage owner unavailable' });
		}
	});

    async function retryContentItems(
        status: 'PENDING' | 'FAILED',
        body: InternalRetryBody | undefined,
        namePrefix: string,
        priority: number,
    ): Promise<{ statusCode: number; payload: InternalRetryResponse }> {
        const { source, ids, limit = status === 'FAILED' ? 100 : 200 } = body ?? {};
        const safeLimit = Math.max(1, Math.min(limit, 500));

        const mediaQueue = getQueue(QUEUE_NAMES.MEDIA);
        if (!mediaQueue) {
            return {
                statusCode: 503,
                payload: {
                    success: false,
                    message: 'Media queue is not available',
                    requeued: 0,
                    total: 0,
                    errors: [],
                },
            };
        }

        let listResult;
        try {
            listResult = await cmsClient.listContentItems({
                status,
                source: ids?.length ? undefined : source?.toUpperCase(),
                ids,
                limit: safeLimit,
            });
        } catch (err) {
            logger.error(`internal ${namePrefix}: failed to list content items from CMS`, err);
            return {
                statusCode: 502,
                payload: {
                    success: false,
                    message: `Failed to fetch ${status} items from CMS: ${err instanceof Error ? err.message : String(err)}`,
                    requeued: 0,
                    total: 0,
                    errors: [],
                },
            };
        }

        const aiQueue = getQueue(QUEUE_NAMES.AI);
        let requeued = 0;
        const errors: string[] = [];

        for (const item of listResult.data) {
            try {
                if (status === 'FAILED') {
                    await cmsClient.updateStatus(item.id, { status: 'PENDING' });
                }
                await enqueueRetryJob(
                    { media: mediaQueue, ai: aiQueue },
                    item,
                    { namePrefix, priority },
                );
                requeued++;
                logger.info(`internal ${namePrefix}: requeued item`, { contentItemId: item.id, source: item.source });
            } catch (err) {
                const msg = `${item.id}: ${err instanceof Error ? err.message : String(err)}`;
                errors.push(msg);
                logger.warn(`internal ${namePrefix}: failed to requeue item`, { contentItemId: item.id, error: msg });
            }
        }

        return {
            statusCode: 200,
            payload: {
                success: true,
                message: `Re-queued ${requeued} of ${listResult.data.length} ${status} items`,
                requeued,
                total: listResult.total,
                errors,
            },
        };
    }

    fastify.post<{ Body: InternalRetryBody; Reply: InternalRetryResponse }>(
        '/internal/retry-pending',
        async (request, reply) => {
            const result = await retryContentItems('PENDING', request.body, 'pipeline-autopilot-pending', 5);
            return reply.status(result.statusCode).send(result.payload);
        }
    );

    fastify.post<{ Body: InternalRetryBody; Reply: InternalRetryResponse }>(
        '/internal/retry-failed',
        async (request, reply) => {
            const result = await retryContentItems('FAILED', request.body, 'pipeline-autopilot-failed', 3);
            return reply.status(result.statusCode).send(result.payload);
        }
    );

    fastify.post<{ Body: { tenant_id?: string }; Reply: { success: boolean; jobId?: string; message?: string } }>(
        '/internal/circulation/sweep-now',
        async (request, reply) => {
            const queue = getQueue(QUEUE_NAMES.NEWS_CIRCULATION);
            if (!queue) {
                return reply.status(503).send({ success: false, message: 'news circulation queue unavailable' });
            }
            const tenantId = request.body?.tenant_id || 'default';
            const job = await queue.add(
                'internal-news-circulation',
                { trigger: 'manual', tenantId } satisfies NewsCirculationJob,
                { priority: 1 }
            );
            return reply.send({ success: true, jobId: job.id ?? undefined, message: 'News circulation source claim queued' });
        }
    );

    fastify.post<{ Reply: { success: boolean; jobId?: string; message?: string } }>(
        '/internal/discovery/sweep-now',
        async (_request, reply) => {
            const queue = getQueue(QUEUE_NAMES.DISCOVERY_SWEEP);
            if (!queue) {
                return reply.status(503).send({ success: false, message: 'discovery sweep queue unavailable' });
            }
            const job = await queue.add('internal-discovery-sweep', { trigger: 'manual' } satisfies DiscoverySweepJob, { priority: 1 });
            return reply.send({ success: true, jobId: job.id ?? undefined, message: 'Discovery sweep queued' });
        }
    );

    fastify.post<{ Reply: { success: boolean; jobId?: string; message?: string } }>(
        '/internal/discovery/build-graph-now',
        async (_request, reply) => {
            const queue = getQueue(QUEUE_NAMES.SOURCE_GRAPH);
            if (!queue) {
                return reply.status(503).send({ success: false, message: 'source graph queue unavailable' });
            }
            const job = await queue.add('internal-source-graph', { trigger: 'manual' } satisfies SourceGraphJob, { priority: 1 });
            return reply.send({ success: true, jobId: job.id ?? undefined, message: 'Source graph build queued' });
        }
    );

    /**
     * POST /internal/jobs/user-content
     *
     * Receives an audio file uploaded by a logged-in user via CMS. Uploads
     * the raw bytes to storage, then enqueues a MediaJob so the existing
     * pipeline (download → transcode → thumbnail → AI) normalizes it to
     * MP4 + thumbnail. The CMS feed's MP4 guard then accepts the item.
     *
     * Multipart fields:
     *   - content_item_id (text, uuid)  REQUIRED
     *   - content_type    (text, PODCAST default)
     *   - tenant_id       (text)
     *   - audio_file      (binary)      REQUIRED
     */
    fastify.post<{ Reply: UserContentResponse }>(
        '/internal/jobs/user-content',
        async (request, reply) => {
            if (activeUserContentAdmissions >= USER_CONTENT_MAX_CONCURRENT_ADMISSIONS) {
                return reply.status(429).send({ success: false, message: 'user-content admission is busy' });
            }
            activeUserContentAdmissions++;
            let spoolDirectory: string | undefined;
            try {
            const parts = (request as unknown as { parts: () => AsyncIterableIterator<unknown> }).parts;
            if (typeof parts !== 'function') {
                return reply.status(500).send({
                    success: false,
                    message: 'multipart parser not registered',
                });
            }

            let contentItemId = '';
            let contentType: ContentType | undefined;
            let claimedTenantId = '';
            let audio: { directory: string; path: string; byteCount: number; format: UserAudioFormat } | undefined;
            const seenFields = new Set<string>();

            try {
                const iter = parts() as AsyncIterableIterator<{
                    type: 'field' | 'file';
                    fieldname: string;
                    value?: string;
                    file?: NodeJS.ReadableStream;
                }>;
                for await (const part of iter) {
                    if (part.type === 'field') {
                        if (!['content_item_id', 'content_type', 'tenant_id'].includes(part.fieldname) || seenFields.has(part.fieldname)) {
                            throw new Error('unexpected or duplicate multipart field');
                        }
                        seenFields.add(part.fieldname);
                        if (part.fieldname === 'content_item_id') contentItemId = String(part.value ?? '').trim();
                        else if (part.fieldname === 'content_type') {
                            const v = String(part.value ?? '').toUpperCase().trim();
                            if (v !== 'PODCAST' && v !== 'VIDEO') throw new Error('invalid content type');
                            contentType = v;
                        }
                        else claimedTenantId = String(part.value ?? '').trim();
                    } else {
                        if (part.fieldname !== 'audio_file' || audio || !part.file) {
                            throw new Error('unexpected or duplicate multipart file');
                        }
                        audio = await spoolUserAudio(part.file);
                        spoolDirectory = audio.directory;
                    }
                }
            } catch {
                logger.warn('User-content multipart admission rejected');
                return reply.status(400).send({
                    success: false,
                    message: 'invalid multipart payload',
                });
            }

            if (!CANONICAL_UUID.test(contentItemId) || !contentType || !claimedTenantId || !audio) {
                return reply.status(400).send({
                    success: false,
                    message: 'content_item_id and audio_file are required',
                });
            }

            const mediaQueue = getQueue(QUEUE_NAMES.MEDIA);
            if (!mediaQueue) {
                return reply.status(500).send({
                    success: false,
                    message: 'media queue is not initialised',
                });
            }

            let item;
            try {
                item = await cmsClient.getContentItem(contentItemId);
            } catch {
                return reply.status(404).send({ success: false, message: 'content item was not found' });
            }
            if (
                item.tenant_id !== claimedTenantId ||
                item.type !== contentType ||
                (item.status && item.status !== 'PENDING')
            ) {
                return reply.status(409).send({ success: false, message: 'content item is not eligible for upload' });
            }

            let ingest;
            try {
                ingest = await resolveIngestProfile(item.tenant_id, 'UPLOAD');
            } catch {
                return reply.status(503).send({ success: false, message: 'tenant media policy is unavailable' });
            }
            const preflightFailure = preflightCheck({
                mimeType: audio.format.mimeType,
                sizeBytes: audio.byteCount,
            }, ingest.rawProfile);
            if (preflightFailure) {
                return reply.status(415).send({ success: false, message: 'upload does not satisfy media policy' });
            }

            const jobId = `user-content-${contentItemId}`;
            const existing = await mediaQueue.getJob(jobId);
            if (existing) {
                const state = await existing.getState();
                if (state !== 'failed') {
                    logger.info('User-content job already accepted', { contentItemId, tenantId: item.tenant_id, jobId: existing.id ?? jobId, state });
                    return reply.status(202).send({
                        success: true,
                        contentItemId,
                        jobId: existing.id ?? jobId,
                        accepted: true,
                        alreadyAccepted: true,
                    });
                }
                return reply.status(409).send({ success: false, contentItemId, jobId: existing.id ?? jobId, message: 'existing upload job requires explicit retry' });
            }

            const sourceKey = getStorageKey(contentItemId, 'original', audio.format.extension);
            let objectCreatedByThisAttempt = false;
            let sourceUrl: string;
            try {
                const existedBeforeUpload = await objectExists(sourceKey);
                sourceUrl = await uploadFile(
                    sourceKey,
                    audio.path,
                    audio.format.mimeType,
                );
                objectCreatedByThisAttempt = !existedBeforeUpload;
            } catch (err) {
                logger.warn('User-content storage upload failed', { contentItemId, tenantId: item.tenant_id });
                return reply.status(502).send({
                    success: false,
                    message: 'failed to upload audio to storage',
                });
            }

            const mediaJob: MediaJob = {
                contentItemId,
                tenantId: item.tenant_id,
                contentType,
                sourceType: 'UPLOAD',
                sourceUrl,
                operations: ['download', 'transcode', 'thumbnail'],
            };
            let job;
            try {
                job = await mediaQueue.add('user-content', mediaJob, { priority: 2, jobId });
            } catch {
                // Queue add can be ambiguous. Re-read the deterministic job
                // before compensating so an accepted upload never loses its
                // object. Only delete an object this request created.
                const accepted = await mediaQueue.getJob(jobId).catch(() => undefined);
                if (accepted) {
                    return reply.status(202).send({ success: true, contentItemId, jobId: accepted.id ?? jobId, accepted: true, alreadyAccepted: true });
                }
                if (objectCreatedByThisAttempt) {
                    await deleteObject(sourceKey).catch(() => undefined);
                }
                return reply.status(503).send({ success: false, message: 'failed to accept upload for processing' });
            }

            logger.info('User-submitted audio enqueued', {
                contentItemId,
                tenantId: item.tenant_id,
                bytes: audio.byteCount,
                mediaClass: audio.format.extension,
                jobId: job.id,
            });

            return reply.status(202).send({
                success: true,
                contentItemId,
                jobId: job.id,
                accepted: true,
            });
            } finally {
                activeUserContentAdmissions--;
                if (spoolDirectory) await rm(spoolDirectory, { recursive: true, force: true }).catch(() => undefined);
            }
        }
    );
}
