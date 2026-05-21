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

// AI services — all model-backed work happens in Enrichment-Service.
// Aggregation passes content_id; Enrichment writes transcripts + embeddings
// to CMS itself.
import {
    transcribeViaEnrichment,
    generateEmbeddingViaEnrichment,
    type TranscriptResult,
} from '../ai/enrichment-client.js';
import { buildEmbeddingText } from '../ai/embeddings.js';

// Media services
import { extractAudio } from '../media/transcoder.js';
import { cleanupTempFile, downloadHttp } from '../media/downloader.js';

export const aiWorker = createWorker({
    queueName: QUEUE_NAMES.AI,
    concurrency: 3, // AI processing with moderate concurrency
    processor: async (job: Job<AIJob>, jobLogger): Promise<void> => {
        const { contentItemId, contentType, operations, textContent, mediaPath, mediaUrl } = job.data;

        jobLogger.info('Processing AI job', {
            contentItemId,
            contentType,
            operations,
            hasMediaPath: !!mediaPath,
        });

        const tempFiles: string[] = [];
        let transcriptText: string | undefined;
        let transcriptWritten = false;

        try {
            // 1. Generate transcript if media path provided and transcript operation requested
            let resolvedMediaPath = mediaPath;

            if (!resolvedMediaPath && mediaUrl) {
                try {
                    jobLogger.info('Downloading media for transcript', { mediaUrl });
                    const expectedExt = contentType === 'PODCAST' ? 'mp3' : 'mp4';
                    const downloadResult = await downloadHttp(mediaUrl, `${contentItemId}_ai`, expectedExt);
                    resolvedMediaPath = downloadResult.filePath;
                    tempFiles.push(resolvedMediaPath);
                } catch (downloadError) {
                    jobLogger.warn('Failed to download media for transcript', {
                        contentItemId,
                        error: downloadError instanceof Error ? downloadError.message : 'Unknown error',
                    });
                }
            }

            if (operations.includes('transcript') && resolvedMediaPath) {
                try {
                    jobLogger.info('Generating transcript', { mediaPath: resolvedMediaPath });

                    // Extract audio if video file
                    let audioPath = resolvedMediaPath;
                    if (resolvedMediaPath.endsWith('.mp4') || resolvedMediaPath.endsWith('.webm')) {
                        audioPath = join(config.mediaTempDir, `${contentItemId}_audio.mp3`);
                        await extractAudio(resolvedMediaPath, audioPath);
                        tempFiles.push(audioPath);
                    }

                    // Transcribe via Enrichment-Service. content_id triggers
                    // server-side write-back to CMS (transcript + link).
                    const result: TranscriptResult = await transcribeViaEnrichment(
                        audioPath,
                        contentItemId,
                        { wordTimestamps: true, requestId: job.id },
                    );
                    transcriptText = result.text;

                    if (transcriptText && transcriptText.length > 0) {
                        if (result.writeBackStatus === 'ok') {
                            transcriptWritten = true;
                            jobLogger.info('Transcript written by Enrichment', {
                                contentItemId,
                                textLength: transcriptText.length,
                                language: result.language,
                            });
                        } else {
                            // Enrichment produced the transcript but couldn't
                            // persist it. Surface as a warning; don't fail the
                            // job — embedding step may still succeed.
                            jobLogger.warn('Enrichment transcript write-back did not complete', {
                                contentItemId,
                                writeBackStatus: result.writeBackStatus,
                                writeBackError: result.writeBackError,
                                textLength: transcriptText.length,
                            });
                        }
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
                        // Generate + persist 384-dim embedding via Enrichment.
                        // content_id triggers server-side write-back to CMS.
                        const embedding = await generateEmbeddingViaEnrichment(
                            embeddingText,
                            contentItemId,
                            { requestId: job.id },
                        );

                        jobLogger.info('Embedding generated and written by Enrichment', {
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
                hasTranscript: transcriptWritten,
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
