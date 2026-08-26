/**
 * Media Worker - handles media download, transcoding, and upload
 * Phase 3: Full implementation
 */
import { Job } from "bullmq";
import { createHash } from "crypto";
import { join } from "path";
import { rm, stat } from "fs/promises";
import { createWorker } from "./base-worker.js";
import {
  QUEUE_NAMES,
  type ContentStageJob,
  type MediaJob,
} from "../queues/index.js";
import { getQueue } from "../queues/index.js";
import { cmsClient, contentStageCorrelation } from "../cms/client.js";
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
  extractThumbnail,
  getMediaInfo,
  containerExtension,
  containerMime,
  extractAudio,
  remuxToMp4,
  transcodeProgressive,
} from "../media/transcoder.js";
import {
  createAndUploadAudioDeliveryLadder,
  preferredAudioRendition,
  type UploadedAudioLadderRendition,
} from "../media/audio-ladder.js";
import { planDeliveryRoute, snapshotDigest } from "../media/route-planner.js";
import { createAndUploadAdaptiveHlsPackage } from "../media/hls-package.js";
import {
  getAttemptStorageKey,
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
import { aiPriorityForContentType } from "../services/ai-queue-priority.js";
import { createLogger } from "../observability/logger.js";
import {
  hasAuthoritativeDurationVerification,
  knownDurationAdmissionFailure,
  PODS_MIN_DURATION_SEC,
} from "../services/pods-admission.js";
import {
  ResourceDeferredError,
  withResourceLease,
} from "../runtime/resource-admission.js";
import {
  registerExistingObjectWithManifest,
  uploadFileWithManifest,
} from "../storage/manifest.js";
import {
  reserveLocalScratch,
  type LocalReservation,
} from "../runtime/local-reservations.js";

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
    args.mediaInfo.duration >= PODS_MIN_DURATION_SEC
  ) {
    reasons.push("captioned long-form audio media");
    return { verdict: "audio_first_show", confidence: 0.62, reasons };
  }
  if (
    args.mediaInfo.hasVideo &&
    args.mediaInfo.hasAudio &&
    args.mediaInfo.duration >= PODS_MIN_DURATION_SEC
  ) {
    reasons.push("long-form audio/video media, visual dependency unknown");
    return { verdict: "unknown", confidence: 0.45, reasons };
  }
  reasons.push("insufficient suitability signals");
  return { verdict: "unknown", confidence: 0.35, reasons };
}

export async function processMediaJob(
  job: Job<MediaJob>,
  jobLogger: ReturnType<typeof createLogger>,
  signal?: AbortSignal,
): Promise<void> {
  const {
    contentItemId,
    contentType,
    sourceType,
    sourceUrl,
    operations,
    downloadRef,
    tenantId: queuedTenantId,
  } = job.data;

  // The normal media worker is an all-stage ingest pipeline. It must never
  // silently reinterpret a one-stage command as permission to run download,
  // transcode, thumbnail, and AI handoff together; Pipeline repair owns
  // those exact one-stage effects through pipeline-repair/v1 instead.
  const requiredOperations: Array<"download" | "transcode" | "thumbnail"> = [
    "download",
    "transcode",
    "thumbnail",
  ];
  const fullPipeline =
    operations.length === requiredOperations.length &&
    requiredOperations.every((operation) => operations.includes(operation));
  if (!fullPipeline) {
    throw new Error(
      "media worker accepts only the canonical full ingest pipeline; use pipeline-repair/v1 for an exact stage",
    );
  }

  jobLogger.info("Processing media job", {
    contentItemId,
    contentType,
    sourceUrl,
    operations,
  });

  // Track temp files for cleanup
  const tempFiles: string[] = [];
  const tempDirectories: string[] = [];
  let localReservation: LocalReservation | undefined;
  let reservationHeartbeat: NodeJS.Timeout | undefined;
  let mediaArtifactManifestId: string | undefined;
  let sourceArtifactUpload:
    { url: string; manifestId: string; bytes: number } | undefined;
  let renditionGenerationId: string | undefined;
  let thumbnailManifestId: string | undefined;

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

    const estimatedScratchBytes = Math.max(
      512 * 1024 * 1024,
      Math.min(
        8 * 1024 * 1024 * 1024,
        (contentItem.duration_sec ?? 2400) * 256 * 1024,
      ),
    );
    localReservation = await reserveLocalScratch(
      job.data.workAttemptId ??
        job.data.contentStage?.attempt_id ??
        job.id?.toString() ??
        contentItemId,
      estimatedScratchBytes,
      { contentId: contentItemId, ownerRole: "aggregation-media-executor" },
    );
    reservationHeartbeat = setInterval(
      () => void localReservation?.heartbeat().catch(() => undefined),
      30_000,
    );
    reservationHeartbeat.unref();

    // 1. Set status to PROCESSING
    if (!job.data.contentStage) {
      await cmsClient.updateStatus(
        contentItemId,
        { status: "PROCESSING" },
        job.id,
        signal,
      );
    }

    // 2. Check if already processed (idempotent)
    const artifactExtension = inferArtifactExtension(
      contentType,
      sourceType,
      downloadRef,
    );
    const legacyProcessedKey = getStorageKey(
      contentItemId,
      "processed",
      artifactExtension,
    );
    const artifactAttemptId =
      job.data.workAttemptId ??
      job.data.contentStage?.attempt_id ??
      String(job.id ?? contentItemId);
    const processedKey = getAttemptStorageKey(
      contentItemId,
      artifactAttemptId,
      "processed",
      artifactExtension,
    );
    const existingProcessedKey = (await objectExists(
      processedKey,
      "primary",
      signal,
    ))
      ? processedKey
      : (await objectExists(legacyProcessedKey, "primary", signal))
        ? legacyProcessedKey
        : undefined;
    if (existingProcessedKey) {
      jobLogger.info("Content already processed, skipping", {
        contentItemId,
      });

      // A bare object-exists result is not proof that a previous attempt
      // produced a valid Pods artifact. Never turn an unknown or undersized
      // historical object into feed-ready metadata without a persisted
      // authoritative duration.
      const podsMedia = contentType === "VIDEO" || contentType === "PODCAST";
      const persistedDurationFailure = knownDurationAdmissionFailure(
        contentType,
        contentItem.duration_sec,
      );
      if (
        persistedDurationFailure ||
        ((contentType === "VIDEO" || contentType === "PODCAST") &&
          contentItem.duration_sec == null)
      ) {
        const reason =
          persistedDurationFailure ?? "media_artifact_duration_unverified";
        jobLogger.warn("Existing media artifact is not eligible for repair", {
          contentItemId,
          reason,
        });
        if (job.data.contentStage && job.data.contentStageClaim) {
          await cmsClient.failContentStage(
            job.data.contentStageClaim,
            "media_policy_rejected",
            reason,
            job.id,
          );
        } else {
          await cmsClient.updateStatus(
            contentItemId,
            { status: "FAILED", failure_reason: reason },
            job.id,
            signal,
          );
        }
        return;
      }

      if (
        podsMedia &&
        !hasAuthoritativeDurationVerification(
          contentItem.metadata,
          contentItem.duration_sec,
        )
      ) {
        // Legacy objects may carry only provider-declared duration. Continue
        // through download/probe/transcode and overwrite the deterministic
        // key instead of promoting unverified bytes to the feed.
        jobLogger.warn(
          "Existing media artifact lacks authoritative duration provenance; reprocessing",
          {
            contentItemId,
          },
        );
      } else {
        // A previous verified attempt may have uploaded the object and then
        // failed before CMS artifact write-back. Repair that idempotent
        // write before enqueueing AI so the feed has playback metadata.
        const publicUrl = getPublicUrl(existingProcessedKey);
        await repairExistingArtifacts(
          contentItemId,
          existingProcessedKey,
          publicUrl,
          job.id,
          job.data.contentStage,
        );
        if (!job.data.contentStage)
          await enqueueAIJob(job, contentItemId, contentType, publicUrl);
        return;
      }
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
        localReservation!.sourceDir,
      );
    } else if (isYouTube) {
      downloadResult = await downloadYouTube(
        sourceUrl,
        contentItemId,
        signal,
        localReservation!.sourceDir,
      );
    } else {
      // The URL suffix is only a temporary download hint. FFprobe, not the
      // source label or URL, decides the persisted container and MIME type.
      downloadResult = await downloadHttp(
        sourceUrl,
        contentItemId,
        undefined,
        signal,
        localReservation!.sourceDir,
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

    // Provider metadata can be missing or stale. FFprobe is authoritative,
    // and this gate is deliberately before transcoding, thumbnail extraction,
    // R2 upload, CMS artifact write-back, and AI handoff.
    // Floor fractional FFprobe output so 269.9 seconds cannot be rounded
    // across the 270-second legal boundary.
    const verifiedDurationSec = Math.floor(mediaInfo.duration);
    const durationFailure = knownDurationAdmissionFailure(
      contentType,
      verifiedDurationSec,
    );
    if (durationFailure) {
      jobLogger.warn("Media rejected by authoritative Pods duration gate", {
        contentItemId,
        durationSec: verifiedDurationSec,
        reason: durationFailure,
      });
      if (job.data.contentStage && job.data.contentStageClaim) {
        await cmsClient.failContentStage(
          job.data.contentStageClaim,
          "media_policy_rejected",
          durationFailure,
          job.id,
        );
      } else {
        await cmsClient.updateStatus(
          contentItemId,
          { status: "FAILED", failure_reason: durationFailure },
          job.id,
          signal,
        );
      }
      return;
    }

    // 5. Resolve the ingest profile for the authoritative tenant.
    const {
      profile: ingestProfile,
      profileId: ingestProfileId,
      rawProfile,
      profileSource,
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
      {
        trustedLongForm:
          (contentType === "VIDEO" || contentType === "PODCAST") &&
          mediaInfo.duration > 2400,
      },
    );
    if (preflightFailure) {
      jobLogger.warn("Media pre-flight rejected the input", {
        contentItemId,
        reason: preflightFailure,
      });
      if (job.data.contentStage && job.data.contentStageClaim) {
        await cmsClient.failContentStage(
          job.data.contentStageClaim,
          "media_policy_rejected",
          preflightFailure,
          job.id,
        );
      } else {
        await cmsClient.updateStatus(
          contentItemId,
          { status: "FAILED", failure_reason: preflightFailure },
          job.id,
          signal,
        );
      }
      return; // stop here — no S3 writes, no AI enqueue
    }

    const preliminarySuitability = classifyMediaSuitability({
      contentType,
      sourceType,
      title: job.data.textContent?.title,
      excerpt: job.data.textContent?.excerpt,
      mediaInfo,
      hasCaptions: Boolean(downloadResult.captions?.segments?.length),
      categories: downloadResult.categories,
      downloadKind: downloadRef?.mediaKind,
    });
    const policyResolution = await cmsClient.resolveMediaDeliveryPolicy(
      {
        tenant_id: tenantId,
        source_type: sourceType,
        media_kind: mediaInfo.visualAvailable ? "video" : "audio",
        suitability: preliminarySuitability.verdict,
        short_form: mediaInfo.duration <= 2400,
      },
      job.id,
      signal,
    );
    // Snapshot only durable CMS policy data. A retry must never infer a new
    // route from an environment value or the file extension.
    const policySnapshot = policyResolution.policy;
    const routeDecision = planDeliveryRoute({
      probe: {
        duration: mediaInfo.duration,
        format: mediaInfo.format,
        normalizedMime: mediaInfo.normalizedMime,
        hasAudio: mediaInfo.hasAudio,
        visualAvailable: mediaInfo.visualAvailable,
        videoCodec: mediaInfo.videoCodec,
        videoProfile: mediaInfo.videoProfile,
        videoLevel: mediaInfo.videoLevel,
        pixelFormat: mediaInfo.pixelFormat,
        audioCodec: mediaInfo.audioCodec,
        width: mediaInfo.width,
        height: mediaInfo.height,
        frameRate: mediaInfo.frameRate,
        bitrateKbps: mediaInfo.bitrateKbps,
        audioBitrateKbps: mediaInfo.audioBitrateKbps,
        audioChannels: mediaInfo.audioChannels,
        audioSampleRate: mediaInfo.audioSampleRate,
        startTime: mediaInfo.startTime,
        seekable: mediaInfo.seekable,
        rotation: mediaInfo.rotation,
        displayAspectRatio: mediaInfo.displayAspectRatio,
        colorSpace: mediaInfo.colorSpace,
        probeDigest: mediaInfo.probeDigest,
      },
      policy: policySnapshot,
      suitability: preliminarySuitability.verdict,
      durationSec: mediaInfo.duration,
      trustedLongForm:
        (contentType === "VIDEO" || contentType === "PODCAST") &&
        mediaInfo.duration > 2400,
    });
    const routeSnapshot = {
      route: routeDecision.route,
      reasons: routeDecision.reasons,
      expected: routeDecision.expected,
      renditions: routeDecision.renditions,
      route_digest: routeDecision.digest,
      input_digest: mediaInfo.probeDigest,
      resource_estimate: {
        source_bytes: originalSourceBytes,
        expected_renditions: routeDecision.renditions.length,
      },
    };
    const probeSnapshot = {
      duration: mediaInfo.duration,
      format: mediaInfo.format,
      normalized_mime: mediaInfo.normalizedMime,
      has_audio: mediaInfo.hasAudio,
      visual_available: mediaInfo.visualAvailable,
      video_codec: mediaInfo.videoCodec,
      video_profile: mediaInfo.videoProfile,
      video_level: mediaInfo.videoLevel,
      pixel_format: mediaInfo.pixelFormat,
      audio_codec: mediaInfo.audioCodec,
      width: mediaInfo.width,
      height: mediaInfo.height,
      frame_rate: mediaInfo.frameRate,
      bitrate_kbps: mediaInfo.bitrateKbps,
      audio_bitrate_kbps: mediaInfo.audioBitrateKbps,
      audio_channels: mediaInfo.audioChannels,
      audio_sample_rate: mediaInfo.audioSampleRate,
      start_time: mediaInfo.startTime,
      seekable: mediaInfo.seekable,
      rotation: mediaInfo.rotation,
      display_aspect_ratio: mediaInfo.displayAspectRatio,
      color_space: mediaInfo.colorSpace,
      probe_digest: mediaInfo.probeDigest,
      streams: mediaInfo.streams,
    };
    const sourceExtension =
      mediaInfo.visualAvailable && mediaInfo.format.includes("mp4")
        ? "mp4"
        : !mediaInfo.visualAvailable && mediaInfo.audioCodec === "aac"
          ? "m4a"
          : (downloadResult.filePath.split(".").pop() || "bin")
              .replace(/[^a-zA-Z0-9]/g, "")
              .toLowerCase() || "bin";
    const sourceContentType =
      mediaInfo.visualAvailable && mediaInfo.format.includes("mp4")
        ? "video/mp4"
        : !mediaInfo.visualAvailable && mediaInfo.audioCodec === "aac"
          ? "audio/mp4"
          : downloadedMime || "application/octet-stream";
    sourceArtifactUpload = await uploadFileWithManifest(
      {
        tenantId,
        contentItemId,
        parentContentItemId: contentItemId,
        artifactRole: "source",
        key: getAttemptStorageKey(
          contentItemId,
          artifactAttemptId,
          "source",
          sourceExtension,
        ),
        filePath: downloadResult.filePath,
        contentType: sourceContentType,
        cacheControl: "public, max-age=31536000, immutable",
        inputDigest: createHash("sha256")
          .update(
            `${contentItemId}:${sourceUrl}:${Math.floor(mediaInfo.duration)}:source`,
          )
          .digest("hex"),
        fenceToken: job.data.contentStage?.fence_token,
        attemptId: isUuid(job.data.contentStage?.attempt_id)
          ? job.data.contentStage?.attempt_id
          : undefined,
        creatorRole: "aggregation-media-executor",
      },
      signal,
    );
    // Persist the pure decision after the immutable source is proven and
    // before any delivery encode, remux, HLS package, or thumbnail work.
    const generation = await cmsClient.createMediaRenditionGeneration(
      {
        tenant_id: tenantId,
        content_item_id: contentItemId,
        source_manifest_id: sourceArtifactUpload.manifestId,
        route_decision: routeSnapshot,
        route_digest: snapshotDigest(routeSnapshot),
        probe_snapshot: probeSnapshot,
        probe_digest: snapshotDigest(probeSnapshot),
        policy_snapshot: policySnapshot,
        policy_digest: snapshotDigest(policySnapshot),
        attempt_id: isUuid(job.data.contentStage?.attempt_id)
          ? job.data.contentStage?.attempt_id
          : undefined,
        fence_token: job.data.contentStage?.fence_token,
      },
      job.id,
      signal,
    );
    renditionGenerationId = generation.id;
    await cmsClient.transitionMediaRenditionGeneration(
      renditionGenerationId,
      "running",
      { tenant_id: tenantId, fence_token: job.data.contentStage?.fence_token },
      job.id,
      signal,
    );

    // 6. Transcode/process media
    let processedPath: string;
    let duration: number;
    let processedMimeType = "video/mp4";
    let isImageArtifact = false;
    let isAudioOnlyArtifact = false;
    // A parent over the atomization limit is never a feed-delivery encode.
    // The immutable source is its durable input; analysis audio and chapters
    // are derived from it. Keeping this decision here (before transcode) is
    // the invariant that prevents a multi-hour upload from consuming a full
    // second encode just to create an artifact nobody may play in Pods.
    const isLongParentSourceFlow =
      (contentType === "VIDEO" || contentType === "PODCAST") &&
      mediaInfo.duration > 2400 &&
      downloadRef?.mediaKind !== "photo";
    let analysisAudioManifestId: string | undefined;
    let analysisAudioUrl: string | undefined;
    let audioLadder: UploadedAudioLadderRendition[] = [];

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
    } else if (isLongParentSourceFlow) {
      processedPath = downloadResult.filePath;
      duration = mediaInfo.duration;
      processedMimeType =
        lookupMime(downloadResult.filePath) || "application/octet-stream";
    } else if (routeDecision.route === "progressive_passthrough") {
      // The planner admitted this only after the strict browser MP4 gate.
      // Reusing it preserves fast-start/timestamps and avoids a pointless
      // second visual encode for already-compliant source material.
      processedPath = downloadResult.filePath;
      duration = mediaInfo.duration;
      processedMimeType = "video/mp4";
    } else if (
      routeDecision.route === "audio_transcode" ||
      routeDecision.route === "audio_passthrough"
    ) {
      audioLadder = await withResourceLease("software_encode", "required", () =>
        createAndUploadAudioDeliveryLadder({
          tenantId,
          contentItemId,
          parentContentItemId: contentItemId,
          attemptId: isUuid(job.data.contentStage?.attempt_id)
            ? job.data.contentStage?.attempt_id
            : undefined,
          fenceToken: job.data.contentStage?.fence_token,
          sourcePath: downloadResult.filePath,
          sourceInfo: mediaInfo,
          sourceArtifact: sourceArtifactUpload,
          allowSourcePassthrough: routeDecision.route === "audio_passthrough",
          outputDir: localReservation!.outputDir,
          outputBaseName: `${contentItemId}-delivery-audio`,
          storagePrefix: `content/${contentItemId}/attempts/${artifactAttemptId}`,
          artifactRole: "delivery_audio",
          creatorRole: "aggregation-media-executor",
          inputDigest: mediaInfo.probeDigest ?? snapshotDigest(probeSnapshot),
          signal,
        }),
      );
      const preferred = preferredAudioRendition(audioLadder);
      processedPath = preferred.localPath ?? downloadResult.filePath;
      duration = mediaInfo.duration;
      processedMimeType = preferred.mimeType;
      isAudioOnlyArtifact = true;
      for (const output of audioLadder)
        if (!output.sourcePassthrough && output.localPath)
          tempFiles.push(output.localPath);
    } else if (routeDecision.route === "progressive_remux") {
      const outPath = join(
        localReservation!.outputDir,
        `${contentItemId}_remux.mp4`,
      );
      const result = await withResourceLease("light_media", "required", () =>
        remuxToMp4(downloadResult.filePath, outPath, { signal }),
      );
      processedPath = result.outputPath;
      duration = result.duration;
      processedMimeType = "video/mp4";
      tempFiles.push(processedPath);
    } else if (routeDecision.route === "adaptive_hls_transcode") {
      // The adaptive package owns every delivery encode, including a
      // stream-copied 360p progressive fallback. Feed it the proven source
      // directly so we do not perform an unused full progressive encode.
      processedPath = downloadResult.filePath;
      duration = mediaInfo.duration;
      processedMimeType = sourceContentType;
    } else if (routeDecision.route === "progressive_transcode") {
      const outPath = join(
        localReservation!.outputDir,
        `${contentItemId}_processed.${outExt}`,
      );
      const result = await withResourceLease(
        "software_encode",
        "required",
        () =>
          transcodeProgressive(
            downloadResult.filePath,
            outPath,
            ingestProfile,
            routeDecision.route === "adaptive_hls_transcode"
              ? Math.min(720, mediaInfo.height ?? 720)
              : undefined,
            { signal },
          ),
      );
      processedPath = result.outputPath;
      duration = result.duration;
      processedMimeType = outMime;
      tempFiles.push(processedPath);
    } else {
      // Pods supports audio playback. A static H.264 wrapper would encode
      // the entire episode just to add black pixels, wasting CPU and R2.
      processedPath = downloadResult.filePath;
      duration = mediaInfo.duration;
      processedMimeType = audioArtifactMime(
        mediaInfo.audioCodec,
        downloadResult.filePath,
      );
      isAudioOnlyArtifact = true;
    }

    jobLogger.info("Transcode complete", { processedPath, duration });

    // Trusted long-form work gets one durable analysis-audio artifact. The
    // Media service then extracts bounded windows from this artifact for
    // segmented STT; it never downloads the parent once per segment.
    if (
      (contentType === "VIDEO" || contentType === "PODCAST") &&
      duration > 2400 &&
      !isImageArtifact
    ) {
      const analysisPath = join(
        localReservation!.outputDir,
        `${contentItemId}_analysis.m4a`,
      );
      await withResourceLease("software_encode", "required", () =>
        extractAudio(processedPath, analysisPath, { signal }),
      );
      tempFiles.push(analysisPath);
      const analysisAttempt = (
        job.data.contentStage?.attempt_id ??
        job.data.workAttemptId ??
        String(job.id ?? "attempt")
      ).replace(/[^a-zA-Z0-9_-]/g, "_");
      const analysisKey = `content/${contentItemId}/attempts/${analysisAttempt}/analysis-audio.m4a`;
      const analysisUpload = await uploadFileWithManifest(
        {
          tenantId,
          contentItemId,
          parentContentItemId: contentItemId,
          artifactRole: "analysis_audio",
          key: analysisKey,
          filePath: analysisPath,
          contentType: "audio/mp4",
          cacheControl: "public, max-age=31536000, immutable",
          inputDigest: createHash("sha256")
            .update(`${contentItemId}:${Math.floor(duration)}:analysis-audio`)
            .digest("hex"),
          fenceToken: job.data.contentStage?.fence_token,
          attemptId: isUuid(job.data.contentStage?.attempt_id)
            ? job.data.contentStage?.attempt_id
            : undefined,
          creatorRole: "aggregation-media-executor",
        },
        signal,
      );
      analysisAudioManifestId = analysisUpload.manifestId;
      analysisAudioUrl = analysisUpload.url;
      jobLogger.info("Long-form analysis audio uploaded", {
        contentItemId,
        manifestId: analysisAudioManifestId,
        bytes: analysisUpload.bytes,
      });
    }

    // 7. Extract thumbnail with profile-driven offset + maxHeight.
    let thumbnailPath: string | undefined;
    let thumbnailUrl: string | undefined;
    let thumbnailBytes = 0;
    try {
      if (isImageArtifact) {
        throw new Error("Skip thumbnail extraction for image artifacts");
      }
      thumbnailPath = join(
        localReservation!.outputDir,
        `${contentItemId}_thumb.jpg`,
      );
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
      const thumbKey = getAttemptStorageKey(
        contentItemId,
        artifactAttemptId,
        "thumbnail",
        "jpg",
      );
      const thumbnailUpload = await uploadFileWithManifest(
        {
          tenantId,
          contentItemId,
          parentContentItemId: contentItemId,
          artifactRole: "thumbnail",
          key: thumbKey,
          filePath: thumbnailPath,
          contentType: "image/jpeg",
          cacheControl: "public, max-age=31536000, immutable",
          inputDigest: createHash("sha256")
            .update(`${contentItemId}:thumbnail:${Math.floor(duration)}`)
            .digest("hex"),
          fenceToken: job.data.contentStage?.fence_token,
          attemptId: isUuid(job.data.contentStage?.attempt_id)
            ? job.data.contentStage?.attempt_id
            : undefined,
          creatorRole: "aggregation-media-executor",
        },
        signal,
      );
      thumbnailUrl = thumbnailUpload.url;
      thumbnailManifestId = thumbnailUpload.manifestId;
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
    const verifiedArtifactExtension =
      isImageArtifact || isLongParentSourceFlow
        ? artifactExtension
        : isAudioOnlyArtifact
          ? audioArtifactExtension(
              mediaInfo.audioCodec,
              downloadResult.filePath,
            )
          : outExt;
    const containerProcessedKey = isImageArtifact
      ? processedKey
      : // Keep the stable processed key for idempotency even when its payload
        // is audio. The authoritative playback_type/mime metadata—not a key
        // suffix—selects the client player.
        isAudioOnlyArtifact
        ? getAttemptStorageKey(
            contentItemId,
            artifactAttemptId,
            "processed",
            verifiedArtifactExtension,
          )
        : getAttemptStorageKey(
            contentItemId,
            artifactAttemptId,
            "processed",
            verifiedArtifactExtension,
          );
    const primaryAudioUpload =
      audioLadder.length > 0 ? preferredAudioRendition(audioLadder) : undefined;
    const mediaUpload = primaryAudioUpload
      ? {
          url: primaryAudioUpload.url,
          manifestId: primaryAudioUpload.manifestId,
          bytes: primaryAudioUpload.bytes,
        }
      : (isLongParentSourceFlow ||
            routeDecision.route === "progressive_passthrough" ||
            routeDecision.route === "adaptive_hls_transcode") &&
          sourceArtifactUpload
        ? sourceArtifactUpload
        : await uploadFileWithManifest(
            {
              tenantId,
              contentItemId,
              parentContentItemId: contentItemId,
              artifactRole: isLongParentSourceFlow
                ? "source"
                : isAudioOnlyArtifact
                  ? "delivery_audio"
                  : "delivery_progressive",
              key: containerProcessedKey,
              filePath: processedPath,
              contentType: processedMimeType,
              cacheControl: "public, max-age=31536000, immutable",
              inputDigest: createHash("sha256")
                .update(
                  `${contentItemId}:${sourceUrl}:${Math.floor(duration)}:${processedMimeType}`,
                )
                .digest("hex"),
              fenceToken: job.data.contentStage?.fence_token,
              attemptId: isUuid(job.data.contentStage?.attempt_id)
                ? job.data.contentStage?.attempt_id
                : undefined,
              creatorRole: "aggregation-media-executor",
            },
            signal,
          );
    const mediaUrl = mediaUpload.url;
    mediaArtifactManifestId = mediaUpload.manifestId;
    jobLogger.info("Processed media uploaded", { mediaUrl });

    let hlsPackage:
      Awaited<ReturnType<typeof createAndUploadAdaptiveHlsPackage>> | undefined;
    // Visual media always receives a native audio alternate when the resolved
    // policy requests it. This is independent of whether the visual primary is
    // progressive or HLS and never manufactures a static video wrapper.
    if (
      !isLongParentSourceFlow &&
      mediaInfo.visualAvailable &&
      policySnapshot.generate_audio_alternate !== false
    ) {
      audioLadder = await withResourceLease("software_encode", "required", () =>
        createAndUploadAudioDeliveryLadder({
          tenantId,
          contentItemId,
          parentContentItemId: contentItemId,
          attemptId: isUuid(job.data.contentStage?.attempt_id)
            ? job.data.contentStage?.attempt_id
            : undefined,
          fenceToken: job.data.contentStage?.fence_token,
          sourcePath: downloadResult.filePath,
          sourceInfo: mediaInfo,
          allowSourcePassthrough: false,
          outputDir: localReservation!.outputDir,
          outputBaseName: `${contentItemId}-delivery-audio`,
          storagePrefix: `content/${contentItemId}/attempts/${artifactAttemptId}`,
          artifactRole: "delivery_audio",
          creatorRole: "aggregation-media-executor",
          inputDigest: mediaInfo.probeDigest ?? snapshotDigest(probeSnapshot),
          signal,
        }),
      );
      for (const output of audioLadder)
        if (output.localPath) tempFiles.push(output.localPath);
    }
    if (routeDecision.route === "adaptive_hls_transcode") {
      const hlsDir = join(
        localReservation!.hlsDir,
        `${contentItemId}_delivery`,
      );
      hlsPackage = await withResourceLease("media_io_package", "required", () =>
        createAndUploadAdaptiveHlsPackage({
          tenantId,
          contentItemId,
          renditionGenerationId: renditionGenerationId!,
          attemptId: isUuid(job.data.contentStage?.attempt_id)
            ? job.data.contentStage?.attempt_id
            : undefined,
          fenceToken: job.data.contentStage?.fence_token,
          sourcePath: processedPath,
          outputDir: hlsDir,
          storagePrefix: `content/${contentItemId}/attempts/${artifactAttemptId}`,
          progressivePath: mediaUrl,
          progressiveManifestId: mediaUpload.manifestId,
          inputDigest: createHash("sha256")
            .update(`${contentItemId}:${mediaInfo.probeDigest}:adaptive-hls`)
            .digest("hex"),
          signal,
        }),
      );
      tempDirectories.push(hlsDir);
    }

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
    const additionalAudioLadderBytes = audioLadder
      .filter((audio) => audio.manifestId !== mediaUpload.manifestId)
      .reduce((total, audio) => total + audio.bytes, 0);

    // Merge download-time YouTube signals (heatmap / sponsor segments /
    // categories) into the item's metadata. Omitted when absent so we
    // never send empty keys (non-YouTube items have none).
    const downloadMeta: Record<string, unknown> = {};
    if (contentType === "VIDEO" || contentType === "PODCAST") {
      downloadMeta["duration_verification"] = {
        source: "ffprobe",
        duration_sec: Math.floor(duration),
      };
      downloadMeta["ingest_profile_provenance"] = {
        source: profileSource,
        profile_id: ingestProfileId,
      };
      if (analysisAudioManifestId) {
        downloadMeta["analysis_audio_manifest_id"] = analysisAudioManifestId;
        downloadMeta["analysis_audio_url"] = analysisAudioUrl;
      }
      if (mediaArtifactManifestId)
        downloadMeta["media_artifact_manifest_id"] = mediaArtifactManifestId;
      if (sourceArtifactUpload)
        downloadMeta["source_artifact_manifest_id"] =
          sourceArtifactUpload.manifestId;
      if (renditionGenerationId)
        downloadMeta["media_rendition_generation_id"] = renditionGenerationId;
      if (isLongParentSourceFlow) {
        downloadMeta["long_parent_source_manifest_id"] =
          mediaArtifactManifestId;
        downloadMeta["delivery_route"] = "source_only_long_form";
        downloadMeta["parent_feed_playback_prohibited"] = true;
      }
      if (thumbnailManifestId)
        downloadMeta["thumbnail_manifest_id"] = thumbnailManifestId;
    }
    if (downloadResult.heatmap?.length)
      downloadMeta["heatmap"] = downloadResult.heatmap;
    if (downloadResult.sponsorSegments?.length)
      downloadMeta["sponsor_segments"] = downloadResult.sponsorSegments;
    if (downloadResult.categories?.length)
      downloadMeta["categories"] = downloadResult.categories;
    const boundedCaptions = downloadResult.captions;
    if (
      boundedCaptions &&
      boundedCaptions.segments.length > 0 &&
      boundedCaptions.segments.length <= 10_000
    ) {
      const fullText = captionsToFullText(boundedCaptions.segments);
      if (fullText.length <= 2_000_000) {
        downloadMeta["caption_artifact"] = {
          full_text: fullText,
          language: boundedCaptions.language,
          segments: boundedCaptions.segments,
          chapters: downloadResult.chapters?.slice(0, 500),
          source: boundedCaptions.isAuto ? "youtube_auto" : "youtube_human",
          provider: "youtube",
        };
      } else {
        jobLogger.warn(
          "Caption artifact exceeded bounded text contract; Media STT will be used",
          { contentItemId, textLength: fullText.length },
        );
      }
    }
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
        // Public playback fields are projected solely by generation activation.
        // This write records non-serving custody and suitability only.
        has_video:
          mediaInfo.visualAvailable &&
          !isAudioOnlyArtifact &&
          !isLongParentSourceFlow,
        visual_available:
          mediaInfo.visualAvailable &&
          !isAudioOnlyArtifact &&
          !isLongParentSourceFlow,
        thumbnail_url: thumbnailUrl,
        duration_sec: Math.floor(duration),
        file_size_bytes:
          processedBytes + thumbnailBytes + additionalAudioLadderBytes,
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
        content_stage: job.data.contentStage,
      },
      job.id,
      signal,
    );

    if (renditionGenerationId) {
      const generationProbeDigest = snapshotDigest(probeSnapshot);
      const rendition = (
        role: string,
        type: "source" | "audio" | "mp4" | "hls",
        upload: { url: string; manifestId: string },
        extra: Record<string, unknown> = {},
      ) => ({
        schema_version: 3,
        id: createHash("sha256")
          .update(`${renditionGenerationId}:${role}:${upload.manifestId}`)
          .digest("hex"),
        role,
        type,
        url: upload.url,
        manifest_id: upload.manifestId,
        rendition_generation_id: renditionGenerationId,
        probe_digest: generationProbeDigest,
        policy_digest: snapshotDigest(policySnapshot),
        ...extra,
      });
      const preferredAudio =
        audioLadder.length > 0
          ? preferredAudioRendition(audioLadder)
          : undefined;
      const audioRenditions = audioLadder.map((audio) =>
        rendition(
          mediaInfo.visualAvailable ? "native_audio_alternate" : "native_audio",
          "audio",
          { url: audio.url, manifestId: audio.manifestId },
          {
            mime_type: audio.mimeType,
            container: audio.container,
            codec: audio.codec,
            codecs: audio.codec === "aac" ? "mp4a.40.2" : audio.codec,
            has_video: false,
            bitrate_kbps: audio.bitrateKbps,
            quality_tier: audio.tier,
            is_primary:
              isAudioOnlyArtifact &&
              preferredAudio?.manifestId === audio.manifestId,
            verification_evidence: {
              measured_bitrate_kbps: audio.bitrateKbps,
              maximum_bitrate_kbps: audio.maxBitrateKbps,
              source_passthrough: audio.sourcePassthrough,
            },
          },
        ),
      );
      let renditionSet: Array<Record<string, unknown>>;
      if (isLongParentSourceFlow) {
        renditionSet = [
          rendition(
            "source",
            "source",
            { url: mediaUrl, manifestId: mediaUpload.manifestId },
            {
              mime_type: processedMimeType,
              serving: false,
              quality_tier: "standard",
            },
          ),
        ];
      } else if (hlsPackage) {
        const progressiveFallback = rendition(
          "progressive_fallback",
          "mp4",
          {
            url: hlsPackage.progressiveUrl,
            manifestId: hlsPackage.progressiveManifestId,
          },
          {
            mime_type: "video/mp4",
            has_video: true,
            height: 360,
            bitrate_kbps: 600,
            quality_tier: "data_saver",
          },
        );
        const standardHls = rendition(
          "hls_access_master",
          "hls",
          {
            url: hlsPackage.standardMasterUrl,
            manifestId: hlsPackage.standardMasterManifestId,
          },
          {
            mime_type: "application/vnd.apple.mpegurl",
            has_video: true,
            quality_tier: "standard",
            package_id: hlsPackage.packageId,
            validation_digest: hlsPackage.validationDigest,
            validation_evidence: hlsPackage.validationEvidence,
            is_primary: true,
            fallback_rendition_id: progressiveFallback.id,
          },
        );
        renditionSet = [
          standardHls,
          rendition(
            "hls_access_master",
            "hls",
            {
              url: hlsPackage.highMasterUrl,
              manifestId: hlsPackage.highMasterManifestId,
            },
            {
              mime_type: "application/vnd.apple.mpegurl",
              has_video: true,
              quality_tier: "high",
              package_id: hlsPackage.packageId,
              validation_digest: hlsPackage.validationDigest,
              fallback_rendition_id: progressiveFallback.id,
            },
          ),
          progressiveFallback,
          ...audioRenditions,
        ];
      } else if (isAudioOnlyArtifact && audioRenditions.length > 0) {
        renditionSet = audioRenditions;
      } else {
        renditionSet = [
          rendition(
            isAudioOnlyArtifact ? "native_audio" : "progressive",
            isAudioOnlyArtifact ? "audio" : "mp4",
            { url: mediaUrl, manifestId: mediaUpload.manifestId },
            {
              mime_type: processedMimeType,
              has_video: mediaInfo.visualAvailable && !isAudioOnlyArtifact,
              quality_tier: "standard",
              is_primary: true,
            },
          ),
          ...audioRenditions,
        ];
      }
      await cmsClient.transitionMediaRenditionGeneration(
        renditionGenerationId,
        "verifying",
        {
          tenant_id: tenantId,
          fence_token: job.data.contentStage?.fence_token,
          rendition_set: renditionSet,
          terminal_proof: {
            output_probe_digest: mediaInfo.probeDigest,
            cms_artifacts_written: true,
          },
        },
        job.id,
        signal,
      );
      await cmsClient.activateMediaRenditionGeneration(
        renditionGenerationId,
        {
          tenant_id: tenantId,
          fence_token: job.data.contentStage?.fence_token,
          terminal_proof: {
            cms_artifacts_written: true,
            active_manifest_ids: [
              mediaUpload.manifestId,
              ...audioLadder.map((audio) => audio.manifestId),
              ...(hlsPackage?.manifestIds ?? []),
            ].filter((id, index, values) => values.indexOf(id) === index),
          },
        },
        job.id,
        signal,
      );
    }

    jobLogger.info("CMS artifacts updated", {
      contentItemId,
      mediaUrl,
      thumbnailUrl,
      duration: Math.floor(duration),
    });

    // CMS playback metadata is now committed. Promote the verified manifests
    // to the active ownership state only after that fenced writeback succeeds;
    // a lost response leaves them recoverable/verified for the next retry.
    for (const manifestId of new Set([
      mediaArtifactManifestId,
      thumbnailManifestId,
      analysisAudioManifestId,
      ...audioLadder.map((audio) => audio.manifestId),
      ...(hlsPackage?.manifestIds ?? []),
    ])) {
      if (!manifestId) continue;
      await cmsClient.transitionArtifactManifest(
        manifestId,
        "active",
        {
          tenant_id: tenantId,
          fence_token: job.data.contentStage?.fence_token,
        },
        job.id,
        signal,
      );
    }

    // 9a. Caption-first: if YouTube gave us a usable caption track, persist
    // it as the transcript now (the free fast-path). Human caption →
    // trusted/terminal; auto caption → displayed default, upgradeable via
    // STT later. Native chapters ride along on the same transcript row.
    let captionState: CaptionState = "none";
    let captionText: string | undefined;
    const captions = downloadResult.captions;
    const chapters = downloadResult.chapters;
    if (!job.data.contentStage && captions && captions.segments.length > 0) {
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
    if (!job.data.contentStage) {
      await enqueueAIJob(
        job,
        contentItemId,
        contentType,
        mediaUrl,
        captionState,
        captionText,
        true,
      );
    }

    jobLogger.info("Media job completed successfully", { contentItemId });
  } catch (error) {
    jobLogger.error("Media job failed", error, { contentItemId });

    if (error instanceof ResourceDeferredError && !job.data.contentStage) {
      // Capacity pressure is recoverable admission, not a media-policy failure.
      throw error;
    }
    if (job.data.contentStage) {
      if (error instanceof ResourceDeferredError) {
        const claim = job.data.contentStageClaim;
        if (claim) {
          await cmsClient.deferContentStage(
            claim,
            error.retryAfterSec,
            error.message,
            job.id,
          );
          return;
        }
      }
      // Download/transcode/upload may already have crossed an external effect
      // boundary. Preserve uncertainty and let CMS verify before any retry.
      const claim = job.data.contentStageClaim;
      if (!claim) throw error;
      await cmsClient
        .uncertainContentStage(
          claim,
          "Media stage may have produced or uploaded an artifact",
          job.id,
        )
        .catch((statusError) =>
          jobLogger.error(
            "Failed to preserve media-stage uncertainty",
            statusError,
          ),
        );
    } else {
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
    }

    throw error;
  } finally {
    if (reservationHeartbeat) clearInterval(reservationHeartbeat);
    await localReservation?.release();
    // Cleanup temp files
    for (const tempFile of tempFiles) {
      await cleanupTempFile(tempFile);
    }
    await Promise.all(
      tempDirectories.map((dir) =>
        rm(dir, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  }
}

export const createLegacyMediaWorker = () =>
  createWorker({
    queueName: QUEUE_NAMES.MEDIA,
    concurrency: 2,
    timeoutMs: config.mediaJobTimeoutMs,
    processor: processMediaJob,
  });

export const createPodsMediaWorker = () =>
  createWorker({
    queueName: QUEUE_NAMES.PODS_MEDIA,
    concurrency: 2,
    timeoutMs: config.mediaJobTimeoutMs,
    deadLetterQueueName: QUEUE_NAMES.PODS_STAGE_DLQ,
    processor: async (
      stageJob: Job<ContentStageJob>,
      jobLogger,
      signal,
    ): Promise<void> => {
      const { claim } = stageJob.data;
      if (claim.lane !== "pods" || claim.stage !== "pods_media_artifacts") {
        await cmsClient.deferContentStage(
          claim,
          1,
          "Wrong-lane delivery to Pods media worker",
          stageJob.id,
        );
        jobLogger.warn("Rejected wrong-lane Pods media delivery", {
          lane: claim.lane,
          stage: claim.stage,
        });
        return;
      }
      await cmsClient.beginContentStage(claim, stageJob.id);
      const heartbeat = setInterval(
        () =>
          void cmsClient
            .heartbeatContentStage(claim, stageJob.id)
            .catch(() => undefined),
        15_000,
      );
      heartbeat.unref();
      try {
        const mediaData: MediaJob = {
          contentItemId: claim.content_item_id,
          tenantId: claim.tenant_id,
          contentType: claim.bounded_input.content_type ?? "VIDEO",
          sourceType: claim.bounded_input.source ?? "YOUTUBE",
          sourceUrl: claim.bounded_input.original_url ?? "",
          textContent: {
            title: claim.bounded_input.title ?? "",
            excerpt: claim.bounded_input.excerpt ?? undefined,
            bodyText: claim.bounded_input.body_text ?? undefined,
          },
          operations: ["download", "transcode", "thumbnail"],
          contentStage: contentStageCorrelation(claim),
          contentStageClaim: claim,
        };
        const mediaJob = Object.assign(stageJob, {
          data: mediaData,
        }) as unknown as Job<MediaJob>;
        await processMediaJob(mediaJob, jobLogger, signal);
      } finally {
        clearInterval(heartbeat);
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
      priority: aiPriorityForContentType(contentType),
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
  contentStage?: MediaJob["contentStage"],
): Promise<void> {
  const ext = processedKey.split(".").pop()?.toLowerCase();
  const extensionSuggestsAudio =
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
  // Stable object keys may use the historical .mp4 suffix for audio-only
  // playback. Probe when recovering a writeback so suffixes never select the
  // wrong player.
  const probed = await getMediaInfo(publicUrl).catch(() => undefined);
  const isAudio =
    extensionSuggestsAudio || Boolean(probed?.hasAudio && !probed.hasVideo);
  const playbackType = isAudio ? "audio" : "mp4";
  const mimeType = isAudio
    ? `audio/${ext || "mpeg"}`
    : isImage
      ? inferImageMimeType(ext || "jpg")
      : containerMime(ext);
  const contentItem = await cmsClient.getContentItem(contentItemId, requestId);
  const registered = await registerExistingObjectWithManifest({
    tenantId: contentItem.tenant_id,
    contentItemId,
    parentContentItemId: contentItemId,
    artifactRole: "source",
    key: processedKey,
    contentType: mimeType,
    inputDigest: createHash("sha256")
      .update(`${contentItemId}:${processedKey}:existing-repair`)
      .digest("hex"),
    fenceToken: contentStage?.fence_token,
    attemptId: isUuid(contentStage?.attempt_id)
      ? contentStage?.attempt_id
      : undefined,
    creatorRole: "aggregation-media-repair",
  });
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
      content_stage: contentStage,
      metadata: { media_artifact_manifest_id: registered.manifestId },
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

function isUuid(value: string | undefined): value is string {
  return Boolean(
    value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
  );
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

function audioArtifactExtension(
  codec: string | undefined,
  filePath: string,
): string {
  switch ((codec ?? "").toLowerCase()) {
    case "aac":
      return "m4a";
    case "opus":
      return "opus";
    case "vorbis":
      return "ogg";
    case "flac":
      return "flac";
    case "mp3":
      return "mp3";
  }
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext && /^[a-z0-9]{2,8}$/.test(ext) ? ext : "m4a";
}

function audioArtifactMime(
  codec: string | undefined,
  filePath: string,
): string {
  switch (audioArtifactExtension(codec, filePath)) {
    case "m4a":
      return "audio/mp4";
    case "opus":
      return "audio/ogg";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "mp3":
      return "audio/mpeg";
    default:
      return String(lookupMime(filePath) || "audio/mpeg");
  }
}
