/**
 * Media Worker - handles media download, transcoding, and upload
 * Phase 3: Full implementation
 */
import { Job } from "bullmq";
import { join } from "path";
import { stat } from "fs/promises";
import { createWorker } from "./base-worker.js";
import { QUEUE_NAMES, type MediaJob } from "../queues/index.js";
import { getQueue } from "../queues/index.js";
import { cmsClient } from "../cms/client.js";
import { config } from "../config/index.js";

// Media services
import {
  downloadYouTube,
  downloadHttp,
  downloadTelegram,
  cleanupTempFile,
  isAllowedYouTubeUrl,
} from "../media/downloader.js";
import {
  transcodeToMp4,
  audioToMp4,
  extractThumbnail,
  getMediaInfo,
  containerExtension,
  containerMime,
} from "../media/transcoder.js";
import {
  uploadFile,
  getStorageKey,
  objectExists,
  getPublicUrl,
} from "../storage/client.js";
import {
  resolveIngestProfile,
  preflightCheck,
} from "../services/quality.service.js";
import { captionsToFullText } from "../media/captions.js";
import { lookup as lookupMime } from "mime-types";

type CaptionState = "youtube_human" | "youtube_auto" | "none";
type MediaSuitabilityVerdict =
  | "audio_first_talking_head"
  | "audio_first_show"
  | "visual_dependent"
  | "unsuitable"
  | "unknown";

interface MediaSuitabilityResult {
  verdict: MediaSuitabilityVerdict;
  confidence: number;
  reasons: string[];
}

function classifyMediaSuitability(args: {
  contentType: string;
  sourceType: string;
  title?: string;
  excerpt?: string;
  mediaInfo: {
    duration: number;
    hasVideo: boolean;
    hasAudio: boolean;
    width?: number;
    height?: number;
  };
  hasCaptions: boolean;
  categories?: string[];
  downloadKind?: string;
}): MediaSuitabilityResult {
  const reasons: string[] = [];
  const text =
    `${args.title ?? ""} ${args.excerpt ?? ""} ${(args.categories ?? []).join(" ")}`.toLowerCase();
  const visualTerms = [
    "sports",
    "match",
    "highlights",
    "documentary",
    "screen",
    "tutorial",
    "explainer",
    "gameplay",
    "animation",
  ];
  const talkingTerms = [
    "podcast",
    "interview",
    "episode",
    "show",
    "conversation",
    "بودكاست",
    "مقابلة",
    "حلقة",
  ];

  if (args.downloadKind === "photo") {
    return {
      verdict: "unsuitable",
      confidence: 0.9,
      reasons: ["image artifact is not audio-first media"],
    };
  }
  if (!args.mediaInfo.hasAudio) {
    return {
      verdict: "unsuitable",
      confidence: 0.85,
      reasons: ["no audio track"],
    };
  }
  if (args.contentType === "PODCAST" || args.sourceType === "PODCAST") {
    reasons.push("podcast source/type");
    return { verdict: "audio_first_talking_head", confidence: 0.85, reasons };
  }
  if (visualTerms.some((term) => text.includes(term))) {
    reasons.push("visual-dependent title/category hint");
    return { verdict: "visual_dependent", confidence: 0.68, reasons };
  }
  if (talkingTerms.some((term) => text.includes(term))) {
    reasons.push("audio-consumable title/category hint");
    return { verdict: "audio_first_show", confidence: 0.72, reasons };
  }
  if (
    args.hasCaptions &&
    args.mediaInfo.hasAudio &&
    args.mediaInfo.duration >= 270
  ) {
    reasons.push("captioned long-form audio media");
    return { verdict: "audio_first_show", confidence: 0.62, reasons };
  }
  if (
    args.mediaInfo.hasVideo &&
    args.mediaInfo.hasAudio &&
    args.mediaInfo.duration >= 270
  ) {
    reasons.push("long-form audio/video media, visual dependency unknown");
    return { verdict: "unknown", confidence: 0.45, reasons };
  }
  reasons.push("insufficient suitability signals");
  return { verdict: "unknown", confidence: 0.35, reasons };
}

export const mediaWorker = createWorker({
  queueName: QUEUE_NAMES.MEDIA,
  concurrency: 2, // Media processing is resource-intensive
  timeoutMs: config.mediaJobTimeoutMs, // 30 min default — FFmpeg transcodes can be slow
  processor: async (job: Job<MediaJob>, jobLogger, signal): Promise<void> => {
    const {
      contentItemId,
      contentType,
      sourceType,
      sourceUrl,
      operations,
      downloadRef,
      tenantId: queuedTenantId,
    } = job.data;

    jobLogger.info("Processing media job", {
      contentItemId,
      contentType,
      sourceUrl,
      operations,
    });

    // Track temp files for cleanup
    const tempFiles: string[] = [];

    try {
      // Resolve the item before work so a legacy queue payload cannot
      // silently fall back to a global quality policy. The CMS tenant is
      // authoritative even when a newer producer supplied tenantId.
      const contentItem = await cmsClient.getContentItem(
        contentItemId,
        job.id,
        signal,
      );
      const tenantId = contentItem.tenant_id;
      if (!tenantId || (queuedTenantId && queuedTenantId !== tenantId)) {
        throw new Error("media job tenant does not match CMS content item");
      }

      // 1. Set status to PROCESSING
      await cmsClient.updateStatus(
        contentItemId,
        { status: "PROCESSING" },
        job.id,
        signal,
      );

      // 2. Check if already processed (idempotent)
      const artifactExtension = inferArtifactExtension(
        contentType,
        sourceType,
        downloadRef,
      );
      const processedKey = getStorageKey(
        contentItemId,
        "processed",
        artifactExtension,
      );
      if (await objectExists(processedKey, "primary", signal)) {
        jobLogger.info("Content already processed, skipping", {
          contentItemId,
        });

        // A previous attempt may have uploaded the object and then
        // failed before CMS artifact write-back. Repair that idempotent
        // write before enqueueing AI so the feed has playback metadata.
        const publicUrl = getPublicUrl(processedKey);
        await repairExistingArtifacts(
          contentItemId,
          processedKey,
          publicUrl,
          job.id,
        );
        await enqueueAIJob(job, contentItemId, contentType, publicUrl);
        return;
      }

      // 3. Download media
      jobLogger.info("Downloading media", { sourceUrl });

      let downloadResult;
      const isYouTube = isAllowedYouTubeUrl(sourceUrl);

      if (sourceType === "TELEGRAM") {
        if (!downloadRef) {
          throw new Error("Missing Telegram downloadRef for media job");
        }
        downloadResult = await downloadTelegram(
          downloadRef,
          contentItemId,
          signal,
        );
      } else if (isYouTube) {
        downloadResult = await downloadYouTube(
          sourceUrl,
          contentItemId,
          signal,
        );
      } else {
        // Podcast enclosure or direct URL
        const extension = contentType === "PODCAST" ? "mp3" : "mp4";
        downloadResult = await downloadHttp(
          sourceUrl,
          contentItemId,
          extension,
          signal,
        );
      }

      tempFiles.push(downloadResult.filePath);
      jobLogger.info("Download complete", {
        filePath: downloadResult.filePath,
        format: downloadResult.format,
      });

      // 4. Get media info
      const mediaInfo = await getMediaInfo(downloadResult.filePath);
      jobLogger.debug("Media info", { ...mediaInfo });

      // 5. Resolve the ingest profile for the authoritative tenant.
      const {
        profile: ingestProfile,
        profileId: ingestProfileId,
        rawProfile,
      } = await resolveIngestProfile(tenantId, sourceType);

      // 5a. Pre-flight: enforce profile constraints (allowed MIME types,
      // max input size, max input duration). Fail-fast before any
      // transcode work runs.
      let originalSourceBytes = 0;
      try {
        originalSourceBytes = (await stat(downloadResult.filePath)).size;
      } catch {
        /* ignore */
      }
      const downloadedMime = (lookupMime(downloadResult.filePath) ||
        undefined) as string | undefined;
      const preflightFailure = preflightCheck(
        {
          mimeType: downloadedMime,
          sizeBytes: originalSourceBytes > 0 ? originalSourceBytes : null,
          durationSec:
            mediaInfo.duration > 0 ? Math.round(mediaInfo.duration) : null,
        },
        rawProfile,
      );
      if (preflightFailure) {
        jobLogger.warn("Media pre-flight rejected the input", {
          contentItemId,
          reason: preflightFailure,
        });
        await cmsClient.updateStatus(
          contentItemId,
          {
            status: "FAILED",
            failure_reason: preflightFailure,
          },
          job.id,
          signal,
        );
        return; // stop here — no S3 writes, no AI enqueue
      }

      // 6. Transcode/process media
      let processedPath: string;
      let duration: number;
      let processedMimeType = "video/mp4";
      let isImageArtifact = false;

      // Container is profile-driven. Image artifacts always pass through
      // and ignore the container choice.
      const outExt = containerExtension(rawProfile?.output_container);
      const outMime = containerMime(rawProfile?.output_container);

      if (
        contentType === "ARTICLE" &&
        sourceType === "TELEGRAM" &&
        downloadRef?.mediaKind === "photo"
      ) {
        processedPath = downloadResult.filePath;
        duration = 0;
        processedMimeType = inferImageMimeType(downloadResult.format);
        isImageArtifact = true;
      } else if (mediaInfo.hasVideo || contentType === "VIDEO") {
        const outPath = join(
          config.mediaTempDir,
          `${contentItemId}_processed.${outExt}`,
        );
        const result = await transcodeToMp4(
          downloadResult.filePath,
          outPath,
          ingestProfile,
          { signal },
        );
        processedPath = result.outputPath;
        duration = result.duration;
        processedMimeType = outMime;
        tempFiles.push(processedPath);
      } else {
        // Audio-only: still use the still-image MP4 wrapper because
        // Pods feed needs a video container. The audio side of the
        // ingest profile (codec + bitrate) is honoured by audioToMp4.
        const outPath = join(
          config.mediaTempDir,
          `${contentItemId}_processed.mp4`,
        );
        const result = await audioToMp4(
          downloadResult.filePath,
          outPath,
          undefined,
          ingestProfile,
          { signal },
        );
        processedPath = result.outputPath;
        duration = result.duration || mediaInfo.duration;
        processedMimeType = "video/mp4";
        tempFiles.push(processedPath);
      }

      jobLogger.info("Transcode complete", { processedPath, duration });

      // 7. Extract thumbnail with profile-driven offset + maxHeight.
      let thumbnailPath: string | undefined;
      let thumbnailUrl: string | undefined;
      let thumbnailBytes = 0;
      try {
        if (isImageArtifact) {
          throw new Error("Skip thumbnail extraction for image artifacts");
        }
        thumbnailPath = join(config.mediaTempDir, `${contentItemId}_thumb.jpg`);
        const thumbOffset = rawProfile?.thumbnail_offset_seconds ?? 2;
        const thumbMaxH = rawProfile?.thumbnail_max_height ?? 360;
        await extractThumbnail(
          processedPath,
          thumbnailPath,
          thumbOffset,
          thumbMaxH,
          { signal },
        );
        tempFiles.push(thumbnailPath);

        // Upload thumbnail
        const thumbKey = getStorageKey(contentItemId, "thumbnail", "jpg");
        thumbnailUrl = await uploadFile(
          thumbKey,
          thumbnailPath,
          "image/jpeg",
          "primary",
          signal,
        );
        try {
          thumbnailBytes = (await stat(thumbnailPath)).size;
        } catch {
          thumbnailBytes = 0;
        }
        jobLogger.info("Thumbnail uploaded", { thumbnailUrl, thumbnailBytes });
      } catch (thumbError) {
        jobLogger.warn("Thumbnail extraction failed (non-blocking)", {
          error: thumbError,
        });
        // Use YouTube thumbnail if available
        if (downloadResult.thumbnailUrl) {
          thumbnailUrl = downloadResult.thumbnailUrl;
        } else if (isImageArtifact) {
          thumbnailUrl = undefined;
        }
      }

      // 8. Upload processed artifact (key extension matches container).
      const containerProcessedKey = isImageArtifact
        ? processedKey
        : getStorageKey(contentItemId, "processed", outExt);
      const mediaUrl = await uploadFile(
        containerProcessedKey,
        processedPath,
        processedMimeType,
        "primary",
        signal,
      );
      jobLogger.info("Processed media uploaded", { mediaUrl });

      let processedBytes = 0;
      try {
        processedBytes = (await stat(processedPath)).size;
      } catch {
        processedBytes = 0;
      }

      if (isImageArtifact) {
        thumbnailUrl = mediaUrl;
      }

      // 9. Update CMS artifacts (size accounting includes processed + thumbnail).
      // Quality bookkeeping is included on first ingest so the Quality
      // system has a baseline to project savings against. CMS treats
      // original_* fields as write-once, so re-runs don't clobber them.
      // originalSourceBytes was computed above during pre-flight.
      const originalBitrateKbps = mediaInfo.bitrateKbps ?? undefined;

      // Merge download-time YouTube signals (heatmap / sponsor segments /
      // categories) into the item's metadata. Omitted when absent so we
      // never send empty keys (non-YouTube items have none).
      const downloadMeta: Record<string, unknown> = {};
      if (downloadResult.heatmap?.length)
        downloadMeta["heatmap"] = downloadResult.heatmap;
      if (downloadResult.sponsorSegments?.length)
        downloadMeta["sponsor_segments"] = downloadResult.sponsorSegments;
      if (downloadResult.categories?.length)
        downloadMeta["categories"] = downloadResult.categories;
      const suitability = classifyMediaSuitability({
        contentType,
        sourceType,
        title: job.data.textContent?.title,
        excerpt: job.data.textContent?.excerpt,
        mediaInfo,
        hasCaptions: Boolean(downloadResult.captions?.segments?.length),
        categories: downloadResult.categories,
        downloadKind: downloadRef?.mediaKind,
      });

      await cmsClient.updateArtifacts(
        contentItemId,
        {
          media_url: mediaUrl,
          thumbnail_url: thumbnailUrl,
          duration_sec: Math.round(duration),
          file_size_bytes: processedBytes + thumbnailBytes,
          original_size_bytes:
            originalSourceBytes > 0 ? originalSourceBytes : undefined,
          original_bitrate_kbps: originalBitrateKbps,
          current_bitrate_kbps: originalBitrateKbps,
          current_quality_profile_id: ingestProfileId ?? undefined,
          media_suitability: suitability.verdict,
          media_suitability_confidence: suitability.confidence,
          media_suitability_reasons: suitability.reasons,
          metadata:
            Object.keys(downloadMeta).length > 0 ? downloadMeta : undefined,
        },
        job.id,
        signal,
      );

      jobLogger.info("CMS artifacts updated", {
        contentItemId,
        mediaUrl,
        thumbnailUrl,
        duration: Math.round(duration),
      });

      // 9a. Caption-first: if YouTube gave us a usable caption track, persist
      // it as the transcript now (the free fast-path). Human caption →
      // trusted/terminal; auto caption → displayed default, upgradeable via
      // STT later. Native chapters ride along on the same transcript row.
      let captionState: CaptionState = "none";
      let captionText: string | undefined;
      const captions = downloadResult.captions;
      const chapters = downloadResult.chapters;
      if (captions && captions.segments.length > 0) {
        captionState = captions.isAuto ? "youtube_auto" : "youtube_human";
        captionText = captionsToFullText(captions.segments);
        try {
          await cmsClient.createTranscript(
            {
              content_item_id: contentItemId,
              full_text: captionText,
              language: captions.language,
              segments: captions.segments,
              chapters: chapters && chapters.length > 0 ? chapters : undefined,
              source: captions.isAuto ? "youtube_auto" : "youtube_human",
              provider: "youtube",
            },
            job.id,
          );
          jobLogger.info("Caption transcript written", {
            contentItemId,
            captionState,
            segments: captions.segments.length,
            chapters: chapters?.length ?? 0,
          });
        } catch (capErr) {
          // Non-blocking: STT can still upgrade later; chapters/caption lost this run.
          jobLogger.warn("Caption transcript write failed (non-blocking)", {
            contentItemId,
            error: capErr instanceof Error ? capErr.message : "Unknown error",
          });
          captionState = "none";
          captionText = undefined;
        }
      }

      // 9b. Enqueue AI job for transcript (STT, if needed) + embedding
      await enqueueAIJob(
        job,
        contentItemId,
        contentType,
        mediaUrl,
        captionState,
        captionText,
        true,
      );

      jobLogger.info("Media job completed successfully", { contentItemId });
    } catch (error) {
      jobLogger.error("Media job failed", error, { contentItemId });

      // Update status to FAILED
      try {
        await cmsClient.updateStatus(
          contentItemId,
          {
            status: "FAILED",
            failure_reason:
              error instanceof Error ? error.message : "Unknown error",
          },
          job.id,
          signal,
        );
      } catch (statusError) {
        jobLogger.error("Failed to update status", statusError);
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
  mediaUrl?: string,
  captionState: CaptionState = "none",
  captionText?: string,
  replaceCompleted = false,
): Promise<void> {
  const aiQueue = getQueue(QUEUE_NAMES.AI);
  if (!aiQueue) {
    throw new Error("AI queue unavailable for required handoff");
  }

  const operations =
    contentType === "ARTICLE" ? ["embedding"] : ["transcript", "embedding"];
  const jobId = `ai-${contentItemId}`;
  const existing = await aiQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed" || (state === "completed" && replaceCompleted)) {
      await existing.remove();
    } else {
      job.log(`AI job already queued for ${contentItemId} (${state})`);
      return;
    }
  }

  await aiQueue.add(
    `ai-${contentType}-${contentItemId}`,
    {
      contentItemId,
      contentType,
      operations,
      textContent: job.data.textContent ?? { title: "" },
      mediaUrl,
      captionState,
      captionText,
    },
    {
      priority: 2,
      jobId,
    },
  );

  job.log(`Enqueued AI job for ${contentItemId}`);
}

async function repairExistingArtifacts(
  contentItemId: string,
  processedKey: string,
  publicUrl: string,
  requestId?: string,
): Promise<void> {
  const ext = processedKey.split(".").pop()?.toLowerCase();
  const isAudio =
    ext === "mp3" ||
    ext === "m4a" ||
    ext === "aac" ||
    ext === "ogg" ||
    ext === "opus";
  const isImage =
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "png" ||
    ext === "webp" ||
    ext === "gif";
  const playbackType = isAudio ? "audio" : "mp4";
  const mimeType = isAudio
    ? `audio/${ext || "mpeg"}`
    : isImage
      ? inferImageMimeType(ext || "jpg")
      : containerMime(ext);
  await cmsClient.updateArtifacts(
    contentItemId,
    {
      media_url: publicUrl,
      thumbnail_url: isImage ? publicUrl : undefined,
      playback_url: publicUrl,
      playback_type: playbackType,
      has_video: !isAudio && !isImage,
      media_renditions: [
        {
          type: playbackType,
          url: publicUrl,
          has_video: !isAudio && !isImage,
          mime_type: mimeType,
          is_primary: true,
        },
      ],
    },
    requestId,
  );
}

function inferImageMimeType(format: string): string {
  const normalized = format.toLowerCase();
  if (normalized === "png") return "image/png";
  if (normalized === "webp") return "image/webp";
  if (normalized === "gif") return "image/gif";
  return "image/jpeg";
}

function inferArtifactExtension(
  contentType: string,
  sourceType: string,
  downloadRef?: {
    mediaKind: "audio" | "voice" | "video" | "photo";
    fileName?: string;
  },
): string {
  if (
    contentType === "ARTICLE" &&
    sourceType === "TELEGRAM" &&
    downloadRef?.mediaKind === "photo"
  ) {
    const fileName = downloadRef.fileName?.toLowerCase() || "";
    if (fileName.endsWith(".png")) return "png";
    if (fileName.endsWith(".webp")) return "webp";
    if (fileName.endsWith(".gif")) return "gif";
    return "jpg";
  }
  return "mp4";
}
