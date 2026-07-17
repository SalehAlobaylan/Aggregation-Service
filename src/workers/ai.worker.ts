/**
 * AI Worker - handles transcript and embedding generation
 * Phase 3: Full implementation
 */
import { Job } from 'bullmq';
import { join } from 'path';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type AIJob } from '../queues/index.js';
import { getQueue } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { config } from '../config/index.js';

// AI services split across two backends:
//   - Media-Service: audio + image processing (transcribe, image embed)
//   - Enrichment-Service: text intelligence (text embed, tags, future LLM)
// Aggregation passes content_id; each service writes its artifact to CMS.
import {
    transcribeViaMedia,
    transcribeAsyncViaMedia,
    embedImageViaMedia,
    type TranscriptResult,
} from '../ai/media-client.js';
import { generateEmbeddingViaEnrichment } from '../ai/enrichment-client.js';
import { buildEmbeddingText } from '../ai/embeddings.js';
import { shouldAtomizeParent } from './atomization.helpers.js';

// Media services
import { extractAudio, getMediaInfo } from '../media/transcoder.js';
import { cleanupTempFile, downloadHttp } from '../media/downloader.js';

export const aiWorker = createWorker({
    queueName: QUEUE_NAMES.AI,
    concurrency: 3, // AI processing with moderate concurrency
    processor: async (job: Job<AIJob>, jobLogger, signal): Promise<void> => {
        const {
            contentItemId,
            contentType,
            operations,
            textContent,
            mediaPath,
            mediaUrl,
            heroImageUrl,
            captionState = 'none',
            captionText,
            forceStt = false,
        } = job.data;

        jobLogger.info('Processing AI job', {
            contentItemId,
            contentType,
            operations,
            hasMediaPath: !!mediaPath,
        });

        const tempFiles: string[] = [];
        // Seed from the YouTube caption (if any) so embedding includes the
        // caption text even when STT runs asynchronously / not at all.
        let transcriptText: string | undefined = captionText;
        let transcriptWritten = false;
        // Embedding gate: an item must not reach READY without a persisted
        // embedding (it would be invisible to retrieval + degrade its news
        // slide). `attempted` = embedding was required and we had text to embed;
        // `written` = Enrichment confirmed the CMS write-back.
        let embeddingAttempted = false;
        let embeddingWritten = false;

        try {
            // 1. Generate transcript if media path provided and transcript operation requested
            const wantsTranscript = operations.includes('transcript');
            // Producer temp files are never a valid cross-job contract. Drain
            // legacy path-bearing payloads by using their durable URL instead.
            // A path-only legacy job will retry rather than read an arbitrary
            // local file.
            let resolvedMediaPath: string | undefined;

            if (wantsTranscript && !resolvedMediaPath && mediaUrl) {
                try {
                    jobLogger.info('Downloading media for transcript', { mediaUrl });
                    const expectedExt = contentType === 'PODCAST' ? 'mp3' : 'mp4';
                    const downloadResult = await downloadHttp(mediaUrl, `${contentItemId}_ai`, expectedExt, signal);
                    resolvedMediaPath = downloadResult.filePath;
                    tempFiles.push(resolvedMediaPath);
                } catch (downloadError) {
                    jobLogger.warn('Failed to download media for transcript', {
                        contentItemId,
                        error: downloadError instanceof Error ? downloadError.message : 'Unknown error',
                    });
                }
            }

            // Caption-first transcript logic:
            //  - youtube_human → caption already written by media worker; skip STT.
            //  - youtube_auto / none → ask the CMS guard (toggle + budget + state
            //    machine) whether to upgrade via STT; if allowed, run it via Media
            //    (existing sync/async routing). Media writes back source=stt_*.
            let sttAllowed = false;
            let transcriptionJobId: string | undefined;
            if (wantsTranscript && captionState === 'youtube_human') {
                transcriptWritten = true; // the human caption IS the transcript
                jobLogger.info('Human YouTube caption present — skipping STT', { contentItemId });
            } else if (wantsTranscript && resolvedMediaPath) {
                try {
                    const decision = await cmsClient.requestStt(contentItemId, forceStt, job.id, signal);
                    sttAllowed = decision.triggered;
                    transcriptionJobId = decision.job_id;
                    if (!sttAllowed) {
                        jobLogger.info('STT skipped by guard', {
                            contentItemId,
                            captionState,
                            reason: decision.reason,
                        });
                    }
                } catch (guardError) {
                    jobLogger.warn('STT guard check failed (skipping STT)', {
                        contentItemId,
                        error: guardError instanceof Error ? guardError.message : 'Unknown error',
                    });
                }
            }

            if (sttAllowed && resolvedMediaPath) {
                try {
                    jobLogger.info('Generating transcript', { mediaPath: resolvedMediaPath });

                    // Extract audio if video file
                    let audioPath = resolvedMediaPath;
                    if (resolvedMediaPath.endsWith('.mp4') || resolvedMediaPath.endsWith('.webm')) {
                        audioPath = join(config.mediaTempDir, `${contentItemId}_audio.mp3`);
                        await extractAudio(resolvedMediaPath, audioPath, { signal });
                        tempFiles.push(audioPath);
                    }

                    // Transcribe via Media-Service. content_id triggers
                    // server-side write-back to CMS (transcript + link).
                    // Route by ACTUAL audio duration, not content type: anything
                    // longer than the threshold goes async to avoid HTTP gateway
                    // timeouts (a long VIDEO is just as risky as a podcast). If
                    // the ffprobe fails, fall back to the content-type heuristic
                    // so a bad probe never drops the job onto a timeout-prone path.
                    let useAsync = contentType === 'PODCAST';
                    try {
                        const { duration } = await getMediaInfo(audioPath);
                        if (duration > 0) {
                            useAsync = duration > config.asyncTranscribeThresholdSec;
                        }
                    } catch (probeError) {
                        jobLogger.debug('Duration probe failed; using content-type heuristic', {
                            contentItemId,
                            error: probeError instanceof Error ? probeError.message : 'Unknown error',
                        });
                    }
                    const result: TranscriptResult = useAsync
                        ? await transcribeAsyncViaMedia(
                              audioPath,
                              contentItemId,
                              { wordTimestamps: true, requestId: job.id, transcriptionJobId, signal },
                          )
                        : await transcribeViaMedia(
                              audioPath,
                              contentItemId,
                              { wordTimestamps: true, requestId: job.id, transcriptionJobId, signal },
                          );
                    transcriptText = result.text;

                    if (transcriptText && transcriptText.length > 0) {
                        if (result.writeBackStatus === 'ok') {
                            transcriptWritten = true;
                            jobLogger.info('Transcript written by Media-Service', {
                                contentItemId,
                                textLength: transcriptText.length,
                                language: result.language,
                            });
                        } else {
                            // Media produced the transcript but couldn't
                            // persist it. Surface as a warning; don't fail the
                            // job — embedding step may still succeed.
                            jobLogger.warn('Media transcript write-back did not complete', {
                                contentItemId,
                                writeBackStatus: result.writeBackStatus,
                                writeBackError: result.writeBackError,
                                textLength: transcriptText.length,
                            });
                        }
                    }
                } catch (transcriptError) {
                    if (transcriptionJobId) {
                        try {
                            await cmsClient.updateTranscriptionJob(
                                transcriptionJobId,
                                {
                                    status: 'failed',
                                    error_message: transcriptError instanceof Error ? transcriptError.message : 'Transcript generation failed',
                                },
                                job.id
                            );
                        } catch (jobUpdateError) {
                            jobLogger.warn('Failed to mark transcription job failed', {
                                contentItemId,
                                transcriptionJobId,
                                error: jobUpdateError instanceof Error ? jobUpdateError.message : 'Unknown error',
                            });
                        }
                    }
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
                        embeddingAttempted = true;
                        // Generate + persist the Qwen3 dense text embedding via
                        // Enrichment. content_id triggers server-side write-back
                        // to CMS.
                        //
                        // For long-form content (ARTICLE/VIDEO/PODCAST) enable:
                        //   - extractTags:   topic tags via LLM (one extra call)
                        // NEWS also gets tags for story clustering and admin
                        // review context. TWEET/COMMENT skip the extra call.
                        const wantsTagExtraction =
                            contentType === 'NEWS'
                            || contentType === 'ARTICLE'
                            || contentType === 'VIDEO'
                            || contentType === 'PODCAST';

                        const embedResult = await generateEmbeddingViaEnrichment(
                            embeddingText,
                            contentItemId,
                            {
                                requestId: job.id,
                                extractTags: wantsTagExtraction,
                                signal,
                            },
                        );

                        embeddingWritten = embedResult.writeBackStatus === 'ok';

                        jobLogger.info('Embedding generated by Enrichment-Service', {
                            contentItemId,
                            embeddingDim: embedResult.embedding.length,
                            textLength: embeddingText.length,
                            tagCount: embedResult.tags?.length ?? 0,
                            tagExtractionEnabled: wantsTagExtraction,
                            writeBackStatus: embedResult.writeBackStatus,
                        });
                    } else {
                        jobLogger.warn('No text available for embedding', { contentItemId });
                    }
                } catch (embeddingError) {
                    // Leave embeddingWritten=false. We DON'T re-throw here so
                    // best-effort secondary steps (image embed) still run, but
                    // the READY gate below will fail the job (→ BullMQ retry)
                    // so the item is never published without its embedding.
                    jobLogger.warn('Embedding generation failed (will block READY)', {
                        contentItemId,
                        error: embeddingError instanceof Error ? embeddingError.message : 'Unknown error',
                    });
                }
            }

            // 3. Image embedding (CLIP) — only if a hero image URL was supplied.
            // Secondary enrichment: always best-effort, never blocks READY.
            if (heroImageUrl) {
                try {
                    const imgResult = await embedImageViaMedia(
                        heroImageUrl,
                        contentItemId,
                        { requestId: job.id, signal },
                    );
                    jobLogger.info('Image embedding generated and written by Media-Service', {
                        contentItemId,
                        embeddingDim: imgResult.embedding.length,
                        heroImageUrl,
                    });
                } catch (imageError) {
                    jobLogger.warn('Image embedding failed (non-blocking)', {
                        contentItemId,
                        heroImageUrl,
                        error: imageError instanceof Error ? imageError.message : 'Unknown error',
                    });
                }
            }

            // 4. Gate READY on the embedding actually persisting. An item with
            // no embedding is invisible to retrieval and its news slide silently
            // degrades — so we refuse to publish it. Throwing routes through the
            // catch below (status → FAILED) and re-throws so BullMQ retries the
            // job; retry-exhausted items stay FAILED (visible) and are repaired
            // by the reconciliation sweep. (Transcript stays best-effort — it's
            // tracked separately by the admin "missing transcript" view.)
            if (embeddingAttempted && !embeddingWritten) {
                throw new Error(
                    `Embedding not persisted for ${contentItemId} — refusing to mark READY`,
                );
            }

            // 5. Set status to READY (all required artifacts exist now)
            let isAtomizedChild = false;
            let shouldPublishEmbeddingPendingChild = false;
            let parentDurationSec: number | null | undefined;
            try {
                const currentItem = await cmsClient.getContentItem(contentItemId, job.id, signal);
                isAtomizedChild = !!currentItem.parent_content_item_id;
                parentDurationSec = currentItem.duration_sec;
                shouldPublishEmbeddingPendingChild =
                    isAtomizedChild && currentItem.feed_visibility === 'embedding_pending';
            } catch (itemError) {
                jobLogger.warn('Could not read content item before READY update', {
                    contentItemId,
                    error: itemError instanceof Error ? itemError.message : 'Unknown error',
                });
            }
            await cmsClient.updateStatus(
                contentItemId,
                shouldPublishEmbeddingPendingChild
                    ? { status: 'READY', feed_visibility: 'visible', chaptering_status: 'published' }
                    : { status: 'READY' },
                job.id,
                signal,
            );

            if ((contentType === 'VIDEO' || contentType === 'PODCAST') && !isAtomizedChild) {
                const atomizationQueue = getQueue(QUEUE_NAMES.ATOMIZATION);
                if (atomizationQueue && shouldAtomizeParent(parentDurationSec)) {
                    if (transcriptWritten) {
                        const atomizationJobId = `atomize-${contentItemId}`;
                        await atomizationQueue.add(
                            atomizationJobId,
                            { contentItemId, reason: 'media-ready' },
                            {
                                priority: 3,
                                jobId: atomizationJobId,
                                removeOnComplete: { age: 3600, count: 200 },
                                removeOnFail: { age: 86400 },
                            }
                        );
                        jobLogger.info('Atomization job enqueued', { contentItemId, transcriptWritten });
                    } else {
                        jobLogger.warn('Atomization deferred until timestamped transcript is written', {
                            contentItemId,
                            durationSec: parentDurationSec,
                        });
                    }
                } else if (atomizationQueue) {
                    jobLogger.info('Atomization skipped for parent media at or under 40 minutes', {
                        contentItemId,
                        durationSec: parentDurationSec,
                    });
                }
            }

            jobLogger.info('AI job completed, status set to READY', {
                contentItemId,
                hasTranscript: transcriptWritten,
                hasEmbedding: embeddingWritten,
            });

        } catch (error) {
            jobLogger.error('AI job failed', error, { contentItemId });

            // Reconcile/repair jobs must NEVER downgrade an item's status: they
            // run against items that are typically already READY but missing an
            // embedding, so a failed re-embed (e.g. a transient Enrichment
            // write-back error) should leave the item as-is and just retry next
            // sweep — not flip a published item to FAILED. Fresh ingestion jobs
            // (still PROCESSING) keep the FAILED transition so genuine failures
            // stay visible.
            const isRepairJob = job.name?.startsWith('reconcile-embed') ?? false;
            if (!isRepairJob) {
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
