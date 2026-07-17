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
import { deleteObject, getStorageKey, objectExists, uploadFile } from '../../storage/client.js';
import { logger } from '../../observability/logger.js';
import { verifyInternalServiceAuth } from '../plugins/internal-auth.js';
import { cmsClient } from '../../cms/client.js';
import { preflightCheck, resolveIngestProfile } from '../../services/quality.service.js';

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
let activeUserContentAdmissions = 0;

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
