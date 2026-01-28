/**
 * Media Worker - handles media download, transcoding, and upload
 * Phase 3: Full implementation
 */
import { Job } from 'bullmq';
import { join } from 'path';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type MediaJob } from '../queues/index.js';
import { getQueue } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { config } from '../config/index.js';

// Media services
import {
    downloadYouTube,
    downloadHttp,
    cleanupTempFile,
} from '../media/downloader.js';
import {
    transcodeToMp4,
    audioToMp4,
    extractThumbnail,
    getMediaInfo,
} from '../media/transcoder.js';
import {
    uploadFile,
    getStorageKey,
    objectExists,
    getPublicUrl,
} from '../storage/client.js';

export const mediaWorker = createWorker({
    queueName: QUEUE_NAMES.MEDIA,
    concurrency: 2, // Media processing is resource-intensive
    processor: async (job: Job<MediaJob>, jobLogger): Promise<void> => {
        const { contentItemId, contentType, sourceUrl, operations } = job.data;
        const sourceType = ((job.data as unknown as Record<string, unknown>).sourceType as string) || 'UNKNOWN';

        jobLogger.info('Processing media job', {
            contentItemId,
            contentType,
            sourceUrl,
            operations,
        });

        // Track temp files for cleanup
        const tempFiles: string[] = [];

        try {
            // 1. Set status to PROCESSING
            await cmsClient.updateStatus(contentItemId, { status: 'PROCESSING' }, job.id);

            // 2. Check if already processed (idempotent)
            const processedKey = getStorageKey(contentItemId, 'processed', 'mp4');
            if (await objectExists(processedKey)) {
                jobLogger.info('Content already processed, skipping', { contentItemId });

                // Still enqueue AI job if needed
                await enqueueAIJob(job, contentItemId, contentType, processedKey);
                return;
            }

            // 3. Download media
            jobLogger.info('Downloading media', { sourceUrl });

            let downloadResult;
            const isYouTube = sourceUrl.includes('youtube.com') || sourceUrl.includes('youtu.be');

            if (isYouTube) {
                downloadResult = await downloadYouTube(sourceUrl, contentItemId);
            } else {
                // Podcast enclosure or direct URL
                const extension = contentType === 'PODCAST' ? 'mp3' : 'mp4';
                downloadResult = await downloadHttp(sourceUrl, contentItemId, extension);
            }

            tempFiles.push(downloadResult.filePath);
            jobLogger.info('Download complete', {
                filePath: downloadResult.filePath,
                format: downloadResult.format,
            });

            // 4. Get media info
            const mediaInfo = await getMediaInfo(downloadResult.filePath);
            jobLogger.debug('Media info', { ...mediaInfo });

            // 5. Transcode to MP4
            let processedPath: string;
            let duration: number;

            if (mediaInfo.hasVideo || contentType === 'VIDEO') {
                // Video: transcode to MP4
                const mp4Path = join(config.mediaTempDir, `${contentItemId}_processed.mp4`);
                const result = await transcodeToMp4(downloadResult.filePath, mp4Path);
                processedPath = result.outputPath;
                duration = result.duration;
                tempFiles.push(processedPath);
            } else {
                // Audio-only (podcast): convert to MP4 with placeholder visual
                const mp4Path = join(config.mediaTempDir, `${contentItemId}_processed.mp4`);
                const result = await audioToMp4(downloadResult.filePath, mp4Path);
                processedPath = result.outputPath;
                duration = result.duration || mediaInfo.duration;
                tempFiles.push(processedPath);
            }

            jobLogger.info('Transcode complete', { processedPath, duration });

            // 6. Extract thumbnail
            let thumbnailPath: string | undefined;
            let thumbnailUrl: string | undefined;

            try {
                thumbnailPath = join(config.mediaTempDir, `${contentItemId}_thumb.jpg`);
                await extractThumbnail(processedPath, thumbnailPath, 2);
                tempFiles.push(thumbnailPath);

                // Upload thumbnail
                const thumbKey = getStorageKey(contentItemId, 'thumbnail', 'jpg');
                thumbnailUrl = await uploadFile(thumbKey, thumbnailPath, 'image/jpeg');
                jobLogger.info('Thumbnail uploaded', { thumbnailUrl });
            } catch (thumbError) {
                jobLogger.warn('Thumbnail extraction failed (non-blocking)', { error: thumbError });
                // Use YouTube thumbnail if available
                if (downloadResult.thumbnailUrl) {
                    thumbnailUrl = downloadResult.thumbnailUrl;
                }
            }

            // 7. Upload processed MP4
            const mediaUrl = await uploadFile(processedKey, processedPath, 'video/mp4');
            jobLogger.info('Processed media uploaded', { mediaUrl });

            // 8. Update CMS artifacts
            await cmsClient.updateArtifacts(contentItemId, {
                media_url: mediaUrl,
                thumbnail_url: thumbnailUrl,
                duration_sec: Math.round(duration),
            }, job.id);

            jobLogger.info('CMS artifacts updated', {
                contentItemId,
                mediaUrl,
                thumbnailUrl,
                duration: Math.round(duration),
            });

            // 9. Enqueue AI job for transcript + embedding
            await enqueueAIJob(job, contentItemId, contentType, processedPath);

            jobLogger.info('Media job completed successfully', { contentItemId });

        } catch (error) {
            jobLogger.error('Media job failed', error, { contentItemId });

            // Update status to FAILED
            try {
                await cmsClient.updateStatus(
                    contentItemId,
                    {
                        status: 'FAILED',
                        failure_reason: error instanceof Error ? error.message : 'Unknown error',
                    },
                    job.id
                );
            } catch (statusError) {
                jobLogger.error('Failed to update status', statusError);
            }

            throw error;
        } finally {
            // Cleanup temp files
            for (const tempFile of tempFiles) {
                await cleanupTempFile(tempFile);
            }
        }
    },
});

/**
 * Enqueue AI job for transcript and embedding generation
 */
async function enqueueAIJob(
    job: Job<MediaJob>,
    contentItemId: string,
    contentType: string,
    mediaPath: string
): Promise<void> {
    const aiQueue = getQueue(QUEUE_NAMES.AI);
    if (!aiQueue) {
        job.log('AI queue not available, skipping AI job');
        return;
    }

    await aiQueue.add(
        `ai-${contentType}-${contentItemId}`,
        {
            contentItemId,
            contentType,
            operations: ['transcript', 'embedding'],
            textContent: {
                title: '', // Will be fetched from CMS if needed
            },
            mediaPath,
        },
        {
            priority: 2,
        }
    );

    job.log(`Enqueued AI job for ${contentItemId}`);
}
