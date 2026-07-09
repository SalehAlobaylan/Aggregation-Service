/**
 * Internal service-to-service routes. Used by CMS to hand off user-submitted
 * content into the same normalize → media → AI pipeline as ingested content.
 */
import type { FastifyInstance } from 'fastify';
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
import { uploadBuffer, getStorageKey } from '../../storage/client.js';
import { logger } from '../../observability/logger.js';
import { verifyInternalServiceAuth } from '../plugins/internal-auth.js';
import { cmsClient } from '../../cms/client.js';

interface UserContentResponse {
    success: boolean;
    contentItemId?: string;
    jobId?: string;
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

function extensionFromMime(mime: string | undefined, filename: string | undefined): string {
    if (filename) {
        const idx = filename.lastIndexOf('.');
        if (idx > -1 && idx < filename.length - 1) {
            return filename.slice(idx + 1).toLowerCase();
        }
    }
    if (!mime) return 'bin';
    const m = mime.toLowerCase();
    if (m.includes('mpeg')) return 'mp3';
    if (m.includes('mp4')) return 'm4a';
    if (m.includes('aac')) return 'aac';
    if (m.includes('wav')) return 'wav';
    if (m.includes('ogg')) return 'ogg';
    if (m.includes('webm')) return 'webm';
    return 'bin';
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
            const parts = (request as unknown as { parts: () => AsyncIterableIterator<unknown> }).parts;
            if (typeof parts !== 'function') {
                return reply.status(500).send({
                    success: false,
                    message: 'multipart parser not registered',
                });
            }

            let contentItemId = '';
            let contentType: ContentType = 'PODCAST';
            // Future use — multi-tenant routing for the job logger.
            // We accept and log tenant_id but don't yet branch on it.
            let tenantId = 'default';
            let audioBuffer: Buffer | null = null;
            let audioFilename: string | undefined;
            let audioMime: string | undefined;

            try {
                const iter = parts() as AsyncIterableIterator<{
                    type: 'field' | 'file';
                    fieldname: string;
                    value?: string;
                    filename?: string;
                    mimetype?: string;
                    toBuffer?: () => Promise<Buffer>;
                }>;
                for await (const part of iter) {
                    if (part.type === 'field') {
                        if (part.fieldname === 'content_item_id') contentItemId = String(part.value ?? '').trim();
                        else if (part.fieldname === 'content_type') {
                            const v = String(part.value ?? '').toUpperCase().trim();
                            if (v === 'PODCAST' || v === 'VIDEO' || v === 'ARTICLE') contentType = v;
                        }
                        else if (part.fieldname === 'tenant_id') tenantId = String(part.value ?? 'default').trim() || 'default';
                    } else if (part.type === 'file' && part.fieldname === 'audio_file' && part.toBuffer) {
                        audioBuffer = await part.toBuffer();
                        audioFilename = part.filename;
                        audioMime = part.mimetype;
                    }
                }
            } catch (err) {
                logger.error('Failed to parse user-content multipart', { error: err });
                return reply.status(400).send({
                    success: false,
                    message: 'invalid multipart payload',
                });
            }

            if (!contentItemId || !audioBuffer || audioBuffer.length === 0) {
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

            const jobId = `user-content-${contentItemId}`;
            const existing = await mediaQueue.getJob(jobId);
            if (existing) {
                const state = await existing.getState();
                if (state === 'failed' || state === 'completed') {
                    await existing.remove();
                } else {
                    logger.info('User-submitted audio already queued', {
                        contentItemId,
                        tenantId,
                        jobId: existing.id ?? jobId,
                        state,
                    });
                    return reply.status(202).send({
                        success: true,
                        contentItemId,
                        jobId: existing.id ?? jobId,
                    });
                }
            }

            const ext = extensionFromMime(audioMime, audioFilename);
            const sourceKey = getStorageKey(contentItemId, 'original', ext);
            let sourceUrl: string;
            try {
                sourceUrl = await uploadBuffer(
                    sourceKey,
                    audioBuffer,
                    audioMime || 'application/octet-stream'
                );
            } catch (err) {
                logger.error('Failed to upload user audio to storage', {
                    contentItemId,
                    tenantId,
                    error: err,
                });
                return reply.status(502).send({
                    success: false,
                    message: 'failed to upload audio to storage',
                });
            }

            const mediaJob: MediaJob = {
                contentItemId,
                contentType,
                sourceType: 'UPLOAD',
                sourceUrl,
                operations: ['download', 'transcode', 'thumbnail'],
            };
            const job = await mediaQueue.add('user-content', mediaJob, {
                priority: 2,
                jobId,
            });

            logger.info('User-submitted audio enqueued', {
                contentItemId,
                tenantId,
                sourceUrl,
                jobId: job.id,
            });

            return reply.status(202).send({
                success: true,
                contentItemId,
                jobId: job.id,
            });
        }
    );
}
