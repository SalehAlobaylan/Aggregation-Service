/**
 * AI Worker - handles transcript and embedding generation
 * Phase 3: Full implementation
 */
import { Job } from 'bullmq';
import { join } from 'path';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type AIJob } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { config } from '../config/index.js';

// AI services
import { transcribe, type TranscriptResult } from '../ai/whisper.js';
import {
    generateEmbedding,
    buildEmbeddingText,
    embeddingService,
} from '../ai/embeddings.js';

// Media services
import { extractAudio } from '../media/transcoder.js';
import { cleanupTempFile } from '../media/downloader.js';

export const aiWorker = createWorker({
    queueName: QUEUE_NAMES.AI,
    concurrency: 3, // AI processing with moderate concurrency
    processor: async (job: Job<AIJob>, jobLogger): Promise<void> => {
        const { contentItemId, contentType, operations, textContent, mediaPath } = job.data;

        jobLogger.info('Processing AI job', {
            contentItemId,
            contentType,
            operations,
            hasMediaPath: !!mediaPath,
        });

        const tempFiles: string[] = [];
        let transcriptText: string | undefined;
        let transcriptId: string | undefined;

        try {
            // 1. Generate transcript if media path provided and transcript operation requested
            if (operations.includes('transcript') && mediaPath) {
                try {
                    jobLogger.info('Generating transcript', { mediaPath });

                    // Extract audio if video file
                    let audioPath = mediaPath;
                    if (mediaPath.endsWith('.mp4') || mediaPath.endsWith('.webm')) {
                        audioPath = join(config.mediaTempDir, `${contentItemId}_audio.mp3`);
                        await extractAudio(mediaPath, audioPath);
                        tempFiles.push(audioPath);
                    }

                    // Transcribe using Whisper
                    const result: TranscriptResult = await transcribe(audioPath);
                    transcriptText = result.text;

                    if (transcriptText && transcriptText.length > 0) {
                        // Store transcript via CMS API
                        const transcriptResponse = await cmsClient.createTranscript({
                            content_item_id: contentItemId,
                            full_text: transcriptText,
                            language: result.language || 'en',
                        }, job.id);

                        transcriptId = transcriptResponse.id;

                        // Link transcript to content item
                        await cmsClient.linkTranscript(contentItemId, {
                            transcript_id: transcriptId,
                        }, job.id);

                        jobLogger.info('Transcript stored and linked', {
                            contentItemId,
                            transcriptId,
                            textLength: transcriptText.length,
                            language: result.language,
                        });
                    }
                } catch (transcriptError) {
                    // Transcript is best-effort, don't fail the job
                    jobLogger.warn('Transcript generation failed (non-blocking)', {
                        contentItemId,
                        error: transcriptError instanceof Error ? transcriptError.message : 'Unknown error',
                    });
                }
            }

            // 2. Generate embedding if requested
            if (operations.includes('embedding')) {
                try {
                    jobLogger.info('Generating embedding', { contentItemId });

                    // Build text for embedding
                    const embeddingText = buildEmbeddingText(
                        textContent.title || '',
                        textContent.excerpt,
                        textContent.bodyText,
                        transcriptText // Use transcript if available
                    );

                    if (embeddingText.length > 0) {
                        // Generate 384-dim embedding
                        const embedding = await generateEmbedding(embeddingText);

                        // Store embedding via CMS API
                        await cmsClient.updateEmbedding(contentItemId, {
                            embedding,
                            topic_tags: [], // Could be extracted from content later
                        }, job.id);

                        jobLogger.info('Embedding stored', {
                            contentItemId,
                            embeddingDim: embedding.length,
                            textLength: embeddingText.length,
                        });
                    } else {
                        jobLogger.warn('No text available for embedding', { contentItemId });
                    }
                } catch (embeddingError) {
                    // Embedding is best-effort, don't fail the job
                    jobLogger.warn('Embedding generation failed (non-blocking)', {
                        contentItemId,
                        error: embeddingError instanceof Error ? embeddingError.message : 'Unknown error',
                    });
                }
            }

            // 3. Set status to READY (all required artifacts should exist now)
            await cmsClient.updateStatus(contentItemId, { status: 'READY' }, job.id);

            jobLogger.info('AI job completed, status set to READY', {
                contentItemId,
                hasTranscript: !!transcriptId,
            });

        } catch (error) {
            jobLogger.error('AI job failed', error, { contentItemId });

            // Update status to FAILED only if not already failed
            try {
                await cmsClient.updateStatus(
                    contentItemId,
                    {
                        status: 'FAILED',
                        failure_reason: error instanceof Error ? error.message : 'AI processing failed',
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
