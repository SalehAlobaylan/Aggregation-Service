/**
 * Exact, CMS-fenced Pipeline repair stage execution.
 *
 * This module intentionally does not enqueue MediaJob or AIJob. Those broad
 * jobs own normal ingest and may run several stages; a repair command owns one
 * stage, one attempt and one receipt only.
 */
import { createHash } from "crypto";
import { join } from "path";
import { mkdir, rm, stat } from "fs/promises";
import type { PipelineRepairStageJob } from "../queues/index.js";
import {
  downloadHttp,
  downloadYouTube,
  cleanupTempFile,
  isAllowedYouTubeUrl,
} from "../media/downloader.js";
import {
  transcodeToMp4,
  extractThumbnail,
  getMediaInfo,
  remuxToMp4,
  transcodeProgressive,
} from "../media/transcoder.js";
import {
  createAndUploadAudioDeliveryLadder,
  preferredAudioRendition,
  type UploadedAudioLadderRendition,
} from "../media/audio-ladder.js";
import { uploadFile } from "../storage/client.js";
import { config } from "../config/index.js";
import { cmsClient } from "../cms/client.js";
import { generateEmbeddingViaEnrichment } from "../ai/enrichment-client.js";
import { buildEmbeddingText } from "../ai/embeddings.js";
import { resolveIngestProfile } from "../services/quality.service.js";
import { knownDurationAdmissionFailure } from "../services/pods-admission.js";
import { planDeliveryRoute, snapshotDigest } from "../media/route-planner.js";
import { uploadFileWithManifest } from "../storage/manifest.js";
import { createAndUploadAdaptiveHlsPackage } from "../media/hls-package.js";

export interface PipelineRepairEffect {
  outputDigest: string;
  output: Record<string, unknown>;
}

function digest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireURL(job: PipelineRepairStageJob): string {
  const value = job.content.mediaUrl ?? job.content.originalUrl;
  if (!value)
    throw new Error("CMS repair command has no approved stage input URL");
  return value;
}

async function download(job: PipelineRepairStageJob, signal?: AbortSignal) {
  return downloadExactURL(job, requireURL(job), signal);
}

async function downloadExactURL(
  job: PipelineRepairStageJob,
  sourceUrl: string,
  signal?: AbortSignal,
) {
  if (isAllowedYouTubeUrl(sourceUrl))
    return downloadYouTube(
      sourceUrl,
      `${job.contentItemId}-${job.attemptId}`,
      signal,
    );
  return downloadHttp(
    sourceUrl,
    `${job.contentItemId}-${job.attemptId}`,
    job.content.type === "PODCAST" ? "mp3" : "mp4",
    signal,
  );
}

function requireVerifiedArtifact(
  job: PipelineRepairStageJob,
  key: string,
): string {
  const value = job.content.metadata?.[key];
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
    throw new Error(`CMS repair command has no verified ${key}`);
  }
  return value;
}

async function mediaDownload(
  job: PipelineRepairStageJob,
  signal?: AbortSignal,
): Promise<PipelineRepairEffect> {
  const source = await download(job, signal);
  try {
    const mediaInfo = await getMediaInfo(source.filePath);
    const durationFailure = knownDurationAdmissionFailure(
      job.content.type,
      Math.floor(mediaInfo.duration),
    );
    if (durationFailure) throw new Error(durationFailure);
    const key = `content/${job.contentItemId}/pipeline-repair/${job.attemptId}/original.${source.format || "bin"}`;
    const url = await uploadFile(
      key,
      source.filePath,
      "application/octet-stream",
      "primary",
      signal,
    );
    const bytes = await stat(source.filePath)
      .then((entry) => entry.size)
      .catch(() => 0);
    // Keep the downloaded original as non-serving provenance. The item remains
    // in its existing lifecycle state until a later exact transcode repair or
    // normal owner workflow produces verified playback metadata.
    await cmsClient.updateArtifacts(
      job.contentItemId,
      {
        metadata: {
          pipeline_repair_original_url: url,
          pipeline_repair_original_digest: digest({ key, bytes, url }),
        },
        expected_item_updated_at: job.itemVersion,
      },
      job.deterministicJobId,
      signal,
    );
    const output = {
      stage: job.stage,
      storage_key: key,
      storage_url: url,
      bytes,
    };
    return { outputDigest: digest(output), output };
  } finally {
    await cleanupTempFile(source.filePath);
  }
}

async function mediaTranscode(
  job: PipelineRepairStageJob,
  signal?: AbortSignal,
): Promise<PipelineRepairEffect> {
  const source = await downloadExactURL(
    job,
    requireVerifiedArtifact(job, "pipeline_repair_original_url"),
    signal,
  );
  const temp: string[] = [source.filePath];
  try {
    const { profile } = await resolveIngestProfile(
      job.tenantId,
      job.content.source,
    );
    const outputPath = join(
      config.mediaTempDir,
      `${job.contentItemId}-${job.attemptId}-repair.mp4`,
    );
    temp.push(outputPath);
    const result = await transcodeToMp4(source.filePath, outputPath, profile, {
      signal,
    });
    const verifiedDurationSec = Math.floor(result.duration);
    const durationFailure = knownDurationAdmissionFailure(
      job.content.type,
      verifiedDurationSec,
    );
    if (durationFailure) throw new Error(durationFailure);
    const key = `content/${job.contentItemId}/pipeline-repair/${job.attemptId}/processed.mp4`;
    const url = await uploadFile(
      key,
      result.outputPath,
      "video/mp4",
      "primary",
      signal,
    );
    const output = {
      stage: job.stage,
      storage_key: key,
      playback_url: url,
      duration_sec: verifiedDurationSec,
    };
    await cmsClient.updateArtifacts(
      job.contentItemId,
      {
        media_url: url,
        playback_url: url,
        playback_type: "mp4",
        duration_sec: verifiedDurationSec,
        metadata: {
          pipeline_repair_processed_url: url,
          pipeline_repair_processed_digest: digest({
            key,
            url,
            duration: verifiedDurationSec,
          }),
          duration_verification: {
            source: "ffprobe",
            duration_sec: verifiedDurationSec,
          },
        },
        expected_item_updated_at: job.itemVersion,
      },
      job.deterministicJobId,
      signal,
    );
    return { outputDigest: digest(output), output };
  } finally {
    await Promise.all(temp.map((path) => cleanupTempFile(path)));
  }
}

async function mediaThumbnail(
  job: PipelineRepairStageJob,
  signal?: AbortSignal,
): Promise<PipelineRepairEffect> {
  const source = await downloadExactURL(
    job,
    requireVerifiedArtifact(job, "pipeline_repair_processed_url"),
    signal,
  );
  const thumb = join(
    config.mediaTempDir,
    `${job.contentItemId}-${job.attemptId}-repair-thumb.jpg`,
  );
  try {
    await extractThumbnail(source.filePath, thumb, 2, 360, { signal });
    const key = `content/${job.contentItemId}/pipeline-repair/${job.attemptId}/thumbnail.jpg`;
    const url = await uploadFile(key, thumb, "image/jpeg", "primary", signal);
    const output = { stage: job.stage, storage_key: key, thumbnail_url: url };
    await cmsClient.updateArtifacts(
      job.contentItemId,
      { thumbnail_url: url, expected_item_updated_at: job.itemVersion },
      job.deterministicJobId,
      signal,
    );
    return { outputDigest: digest(output), output };
  } finally {
    await cleanupTempFile(source.filePath);
    await cleanupTempFile(thumb);
  }
}

async function textEmbedding(
  job: PipelineRepairStageJob,
  signal?: AbortSignal,
): Promise<PipelineRepairEffect> {
  const text = buildEmbeddingText(
    job.content.title ?? "",
    job.content.excerpt,
    job.content.bodyText,
  );
  if (!text.trim())
    throw new Error("CMS repair command has no text for text_embedding");
  const result = await generateEmbeddingViaEnrichment(text, job.contentItemId, {
    requestId: job.deterministicJobId,
    extractTags: job.content.type === "VIDEO" || job.content.type === "PODCAST",
    signal,
    pipelineRepair: {
      repair_id: job.repairId,
      attempt_id: job.attemptId,
      claim_token: job.claimToken,
      fence_token: job.fenceToken,
      expected_item_version: job.itemVersion,
      input_digest: job.effectInputDigest,
    },
  });
  if (result.writeBackStatus !== "ok")
    throw new Error("Enrichment did not persist the repaired embedding");
  const output = {
    stage: job.stage,
    dimensions: result.embedding.length,
    tags: result.tags?.length ?? 0,
    write_back: result.writeBackStatus,
  };
  return { outputDigest: digest(output), output };
}

function metadataString(job: PipelineRepairStageJob, key: string): string {
  const value = job.content.metadata?.[key];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`CMS delivery repair has no ${key}`);
  return value.trim();
}

function routeProbe(info: Awaited<ReturnType<typeof getMediaInfo>>) {
  return {
    duration: info.duration,
    format: info.format,
    normalizedMime: info.normalizedMime,
    hasAudio: info.hasAudio,
    visualAvailable: info.visualAvailable,
    videoCodec: info.videoCodec,
    videoProfile: info.videoProfile,
    videoLevel: info.videoLevel,
    pixelFormat: info.pixelFormat,
    audioCodec: info.audioCodec,
    width: info.width,
    height: info.height,
    frameRate: info.frameRate,
    bitrateKbps: info.bitrateKbps,
    audioBitrateKbps: info.audioBitrateKbps,
    audioChannels: info.audioChannels,
    audioSampleRate: info.audioSampleRate,
    startTime: info.startTime,
    seekable: info.seekable,
    rotation: info.rotation,
    displayAspectRatio: info.displayAspectRatio,
    colorSpace: info.colorSpace,
    probeDigest: info.probeDigest,
  };
}

/** A repair creates a replacement rendition generation from an exact verified
 * source manifest. It never overwrites legacy playback fields directly. */
async function mediaDeliveryGeneration(
  job: PipelineRepairStageJob,
  signal?: AbortSignal,
): Promise<PipelineRepairEffect> {
  const sourceManifestId = metadataString(job, "source_artifact_manifest_id");
  const sourceManifest = await cmsClient.getArtifactManifest(
    sourceManifestId,
    job.deterministicJobId,
    signal,
  );
  if (
    !["verified", "active"].includes(sourceManifest.state) ||
    sourceManifest.artifact_role !== "source" ||
    !sourceManifest.public_url
  )
    throw new Error(
      "delivery repair source manifest is not proven and retrievable",
    );
  const source = await downloadExactURL(job, sourceManifest.public_url, signal);
  const tempPaths: string[] = [source.filePath];
  try {
    const info = await getMediaInfo(source.filePath, { signal });
    const policyResolution = await cmsClient.resolveMediaDeliveryPolicy(
      {
        tenant_id: job.tenantId,
        source_type: job.content.source,
        media_kind: info.visualAvailable ? "video" : "audio",
        short_form: info.duration <= 2400,
      },
      job.deterministicJobId,
      signal,
    );
    const policy = policyResolution.policy;
    const decision = planDeliveryRoute({
      probe: routeProbe(info),
      policy,
      suitability: "unknown",
      durationSec: info.duration,
      trustedLongForm: info.duration > 2400,
    });
    if (
      decision.route === "terminal_invalid_media" ||
      decision.route === "deferred_capacity"
    )
      throw new Error(`delivery repair route is ${decision.route}`);
    const routeSnapshot = {
      route: decision.route,
      reasons: decision.reasons,
      expected: decision.expected,
      renditions: decision.renditions,
      route_digest: decision.digest,
      input_digest: info.probeDigest,
      repair_id: job.repairId,
    };
    const probeSnapshot = { ...routeProbe(info), streams: info.streams };
    const generationProbeDigest = snapshotDigest(probeSnapshot);
    const generationPolicyDigest = snapshotDigest(policy);
    const generation = await cmsClient.createMediaRenditionGeneration(
      {
        tenant_id: job.tenantId,
        content_item_id: job.contentItemId,
        source_manifest_id: sourceManifest.id,
        route_decision: routeSnapshot,
        route_digest: snapshotDigest(routeSnapshot),
        probe_snapshot: probeSnapshot,
        probe_digest: generationProbeDigest,
        policy_snapshot: policy,
        policy_digest: generationPolicyDigest,
        attempt_id: job.attemptId,
        fence_token: job.fenceToken,
      },
      job.deterministicJobId,
      signal,
    );
    await cmsClient.transitionMediaRenditionGeneration(
      generation.id,
      "running",
      { tenant_id: job.tenantId, fence_token: job.fenceToken },
      job.deterministicJobId,
      signal,
    );
    const digestBase = `${job.contentItemId}:${job.attemptId}:${info.probeDigest}`;
    const renditions: Array<Record<string, unknown>> = [];
    let audioLadder: UploadedAudioLadderRendition[] = [];
    const add = (
      role: string,
      type: "source" | "audio" | "mp4" | "hls",
      upload: { url: string; manifestId: string },
      primary = false,
      extra: Record<string, unknown> = {},
    ) => {
      const value = {
        schema_version: 3,
        id: snapshotDigest({
          role,
          generation: generation.id,
          manifest: upload.manifestId,
        }),
        role,
        type,
        rendition_generation_id: generation.id,
        manifest_id: upload.manifestId,
        url: upload.url,
        quality_tier: "standard",
        is_primary: primary,
        policy_digest: generationPolicyDigest,
        probe_digest: generationProbeDigest,
        verification: "manifest_verified",
        ...extra,
      };
      renditions.push(value);
      return value;
    };
    const produceAudioLadder = async (allowSourcePassthrough: boolean) => {
      audioLadder = await createAndUploadAudioDeliveryLadder({
        tenantId: job.tenantId,
        contentItemId: job.contentItemId,
        parentContentItemId: job.contentItemId,
        attemptId: job.attemptId,
        fenceToken: job.fenceToken,
        sourcePath: source.filePath,
        sourceInfo: info,
        sourceArtifact: {
          url: sourceManifest.public_url!,
          manifestId: sourceManifest.id,
          bytes: Number(sourceManifest.size_bytes ?? 0),
        },
        allowSourcePassthrough,
        outputDir: config.mediaTempDir,
        outputBaseName: `${job.contentItemId}-${job.attemptId}-delivery-audio`,
        storagePrefix: `content/${job.contentItemId}/pipeline-repair/${job.attemptId}`,
        artifactRole: "delivery_audio",
        creatorRole: "aggregation-pipeline-repair",
        inputDigest: snapshotDigest({ digestBase, role: "audio-ladder" }),
        signal,
      });
      for (const audio of audioLadder)
        if (!audio.sourcePassthrough && audio.localPath)
          tempPaths.push(audio.localPath);
      return audioLadder;
    };
    const appendAudioLadder = (primary: boolean) => {
      const preferred = primary
        ? preferredAudioRendition(audioLadder)
        : undefined;
      for (const audio of audioLadder) {
        add(
          info.visualAvailable ? "native_audio_alternate" : "native_audio",
          "audio",
          audio,
          primary && audio.manifestId === preferred?.manifestId,
          {
            mime_type: audio.mimeType,
            container: audio.container,
            codec: audio.codec,
            codecs: audio.codec === "aac" ? "mp4a.40.2" : audio.codec,
            has_video: false,
            quality_tier: audio.tier,
            bitrate_kbps: audio.bitrateKbps,
            verification_evidence: {
              measured_bitrate_kbps: audio.bitrateKbps,
              maximum_bitrate_kbps: audio.maxBitrateKbps,
              source_passthrough: audio.sourcePassthrough,
            },
          },
        );
      }
    };
    if (decision.route === "source_only_long_form") {
      add("source", "source", {
        url: sourceManifest.public_url,
        manifestId: sourceManifest.id,
      });
    } else if (!info.visualAvailable) {
      await produceAudioLadder(decision.route === "audio_passthrough");
      appendAudioLadder(true);
    } else {
      let progressive: { url: string; manifestId: string };
      if (
        decision.route === "adaptive_hls_transcode" ||
        decision.route === "progressive_passthrough"
      )
        progressive = {
          url: sourceManifest.public_url,
          manifestId: sourceManifest.id,
        };
      else {
        const path = join(
          config.mediaTempDir,
          `${job.contentItemId}-${job.attemptId}-delivery.mp4`,
        );
        tempPaths.push(path);
        const output =
          decision.route === "progressive_remux"
            ? await remuxToMp4(source.filePath, path, { signal })
            : await transcodeProgressive(
                source.filePath,
                path,
                undefined,
                Math.min(720, info.height ?? 720),
                { signal },
              );
        progressive = await uploadFileWithManifest(
          {
            tenantId: job.tenantId,
            contentItemId: job.contentItemId,
            parentContentItemId: job.contentItemId,
            attemptId: job.attemptId,
            fenceToken: job.fenceToken,
            artifactRole: "delivery_progressive",
            key: `content/${job.contentItemId}/pipeline-repair/${job.attemptId}/delivery.mp4`,
            filePath: output.outputPath,
            contentType: "video/mp4",
            cacheControl: "public, max-age=31536000, immutable",
            inputDigest: snapshotDigest({ digestBase, role: "progressive" }),
            creatorRole: "aggregation-pipeline-repair",
          },
          signal,
        );
      }
      if (policy.generate_audio_alternate !== false)
        await produceAudioLadder(false);
      if (decision.route === "adaptive_hls_transcode") {
        const hlsDir = join(
          config.mediaTempDir,
          `${job.contentItemId}-${job.attemptId}-hls`,
        );
        await mkdir(hlsDir, { recursive: true });
        try {
          const hls = await createAndUploadAdaptiveHlsPackage({
            tenantId: job.tenantId,
            contentItemId: job.contentItemId,
            renditionGenerationId: generation.id,
            attemptId: job.attemptId,
            fenceToken: job.fenceToken,
            sourcePath: source.filePath,
            outputDir: hlsDir,
            storagePrefix: `content/${job.contentItemId}/pipeline-repair/${job.attemptId}`,
            progressivePath: progressive.url,
            progressiveManifestId: progressive.manifestId,
            inputDigest: snapshotDigest({ digestBase, role: "hls" }),
            signal,
          });
          const progressiveFallback = add(
            "progressive_fallback",
            "mp4",
            { url: hls.progressiveUrl, manifestId: hls.progressiveManifestId },
            false,
            { quality_tier: "data_saver", height: 360, bitrate_kbps: 600 },
          );
          add(
            "hls_access_master",
            "hls",
            {
              url: hls.standardMasterUrl,
              manifestId: hls.standardMasterManifestId,
            },
            true,
            {
              package_id: hls.packageId,
              validation_digest: hls.validationDigest,
              fallback_rendition_id: progressiveFallback.id,
            },
          );
          add(
            "hls_access_master",
            "hls",
            { url: hls.highMasterUrl, manifestId: hls.highMasterManifestId },
            false,
            {
              quality_tier: "high",
              package_id: hls.packageId,
              validation_digest: hls.validationDigest,
              fallback_rendition_id: progressiveFallback.id,
            },
          );
          appendAudioLadder(false);
        } finally {
          await rm(hlsDir, { recursive: true, force: true });
        }
      } else {
        add("progressive_primary", "mp4", progressive, true);
        appendAudioLadder(false);
      }
    }
    await cmsClient.transitionMediaRenditionGeneration(
      generation.id,
      "verifying",
      {
        tenant_id: job.tenantId,
        fence_token: job.fenceToken,
        rendition_set: renditions,
        terminal_proof: {
          repair_id: job.repairId,
          source_manifest_id: sourceManifest.id,
          route: decision.route,
          output_probe_digest: info.probeDigest,
        },
      },
      job.deterministicJobId,
      signal,
    );
    const activeManifestIds = [
      ...new Set(
        renditions
          .map((rendition) => rendition.manifest_id)
          .filter((value): value is string => typeof value === "string"),
      ),
    ];
    await cmsClient.activateMediaRenditionGeneration(
      generation.id,
      {
        tenant_id: job.tenantId,
        fence_token: job.fenceToken,
        terminal_proof: {
          repair_id: job.repairId,
          playback_health: "manifest_verified",
          active_manifest_ids: activeManifestIds,
        },
      },
      job.deterministicJobId,
      signal,
    );
    for (const manifestId of activeManifestIds) {
      await cmsClient.transitionArtifactManifest(
        manifestId,
        "active",
        { tenant_id: job.tenantId, fence_token: job.fenceToken },
        job.deterministicJobId,
        signal,
      );
    }
    const output = {
      stage: job.stage,
      generation_id: generation.id,
      source_manifest_id: sourceManifest.id,
      route: decision.route,
      rendition_count: renditions.length,
    };
    return { outputDigest: digest(output), output };
  } finally {
    await Promise.all(tempPaths.map((path) => cleanupTempFile(path)));
  }
}

export async function executePipelineRepairStage(
  job: PipelineRepairStageJob,
  signal?: AbortSignal,
): Promise<PipelineRepairEffect> {
  switch (job.stage) {
    case "media_download":
      return mediaDownload(job, signal);
    case "media_transcode":
      return mediaTranscode(job, signal);
    case "media_thumbnail":
      return mediaThumbnail(job, signal);
    case "media_delivery_generation":
      return mediaDeliveryGeneration(job, signal);
    case "text_embedding":
      return textEmbedding(job, signal);
  }
}
