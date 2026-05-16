/**
 * Internal service-to-service routes. Used by CMS to hand off user-submitted
 * content into the same normalize → media → AI pipeline as ingested content.
 */
import type { FastifyInstance } from 'fastify';
import { getQueue, QUEUE_NAMES, type MediaJob, type ContentType } from '../../queues/index.js';
import { uploadBuffer, getStorageKey } from '../../storage/client.js';
import { logger } from '../../observability/logger.js';
import { verifyInternalServiceAuth } from '../plugins/internal-auth.js';

interface UserContentResponse {
    success: boolean;
    contentItemId?: string;
    jobId?: string;
    message?: string;
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

            const mediaQueue = getQueue(QUEUE_NAMES.MEDIA);
            if (!mediaQueue) {
                return reply.status(500).send({
                    success: false,
                    message: 'media queue is not initialised',
                });
            }

            const mediaJob: MediaJob = {
                contentItemId,
                contentType,
                sourceType: 'UPLOAD',
                sourceUrl,
                operations: ['download', 'transcode', 'thumbnail'],
            };
            const job = await mediaQueue.add('user-content', mediaJob);

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
