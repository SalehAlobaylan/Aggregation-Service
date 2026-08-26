import { join } from "path";
import type { ManifestUploadInput } from "../storage/manifest.js";
import { uploadFileWithManifest } from "../storage/manifest.js";
import {
  planAudioDeliveryLadder,
  resolveAudioBitrateKbps,
  transcodeAudioLadderToM4a,
  type AudioQualityTier,
  type FfmpegRunOptions,
  type MediaInfo,
} from "./transcoder.js";
import { snapshotDigest } from "./route-planner.js";

export interface UploadedAudioLadderRendition {
  tier: AudioQualityTier;
  url: string;
  manifestId: string;
  bitrateKbps: number;
  maxBitrateKbps: number;
  sourcePassthrough: boolean;
  bytes: number;
  duration: number;
  mimeType: string;
  container: string;
  codec: string;
  localPath?: string;
}

export interface CreateAudioDeliveryLadderInput {
  tenantId: string;
  contentItemId?: string;
  parentContentItemId?: string;
  atomizationGenerationId?: string;
  atomizationChapterUnitId?: string;
  attemptId?: string;
  fenceToken?: string;
  sourcePath: string;
  sourceInfo: MediaInfo;
  sourceArtifact?: { url: string; manifestId: string; bytes?: number };
  allowSourcePassthrough: boolean;
  outputDir: string;
  outputBaseName: string;
  storagePrefix: string;
  artifactRole: ManifestUploadInput["artifactRole"];
  creatorRole: string;
  inputDigest: string;
  startSec?: number;
  durationSec?: number;
  signal?: AbortSignal;
}

const tierOrder: Record<AudioQualityTier, number> = {
  data_saver: 0,
  standard: 1,
  high: 2,
};

/**
 * Produces and uploads the complete native-audio serving ladder. Encoded tiers
 * share one FFmpeg process; an already-compliant source may occupy exactly one
 * measured tier while lower ceilings are still generated for strict caps.
 */
export async function createAndUploadAudioDeliveryLadder(
  input: CreateAudioDeliveryLadderInput,
): Promise<UploadedAudioLadderRendition[]> {
  const measuredSourceBitrate = await resolveAudioBitrateKbps(
    input.sourcePath,
    input.sourceInfo,
    { signal: input.signal },
  );
  const plan = planAudioDeliveryLadder(
    measuredSourceBitrate,
    input.allowSourcePassthrough && input.startSec == null,
  );
  if (!plan.sourceTier && plan.encode.length === 0)
    throw new Error(
      "audio delivery ladder requires an exact source bitrate measurement",
    );
  const specs = plan.encode.map((entry) => ({
    ...entry,
    outputPath: join(
      input.outputDir,
      `${input.outputBaseName}-${entry.tier}-${entry.targetBitrateKbps}k.m4a`,
    ),
  }));
  const encoded = await transcodeAudioLadderToM4a(input.sourcePath, specs, {
    inputInfo: input.sourceInfo,
    startSec: input.startSec,
    durationSec: input.durationSec,
    signal: input.signal,
  } satisfies FfmpegRunOptions & {
    inputInfo: MediaInfo;
    startSec?: number;
    durationSec?: number;
  });
  const renditions: UploadedAudioLadderRendition[] = [];
  if (plan.sourceTier) {
    if (!input.sourceArtifact)
      throw new Error(
        "audio source passthrough requires a verified source manifest",
      );
    renditions.push({
      tier: plan.sourceTier,
      url: input.sourceArtifact.url,
      manifestId: input.sourceArtifact.manifestId,
      bitrateKbps: plan.sourceBitrateKbps!,
      maxBitrateKbps:
        plan.sourceTier === "data_saver"
          ? 64
          : plan.sourceTier === "standard"
            ? 128
            : 192,
      sourcePassthrough: true,
      bytes: input.sourceArtifact.bytes ?? 0,
      duration: input.sourceInfo.duration,
      mimeType: input.sourceInfo.normalizedMime ?? "application/octet-stream",
      container: input.sourceInfo.format.includes("mp3") ? "mp3" : "m4a",
      codec: input.sourceInfo.audioCodec ?? "unknown",
      localPath: input.sourcePath,
    });
  }
  for (const output of encoded) {
    const uploaded = await uploadFileWithManifest(
      {
        tenantId: input.tenantId,
        contentItemId: input.contentItemId,
        parentContentItemId: input.parentContentItemId,
        atomizationGenerationId: input.atomizationGenerationId,
        atomizationChapterUnitId: input.atomizationChapterUnitId,
        attemptId: input.attemptId,
        fenceToken: input.fenceToken,
        artifactRole: input.artifactRole,
        key: `${input.storagePrefix}/audio-${output.tier}-${output.targetBitrateKbps}k.m4a`,
        filePath: output.outputPath,
        contentType: "audio/mp4",
        cacheControl: "public, max-age=31536000, immutable",
        inputDigest: snapshotDigest({
          source: input.inputDigest,
          tier: output.tier,
          target_bitrate_kbps: output.targetBitrateKbps,
          start_sec: input.startSec,
          duration_sec: input.durationSec,
        }),
        creatorRole: input.creatorRole,
      },
      input.signal,
    );
    renditions.push({
      tier: output.tier,
      url: uploaded.url,
      manifestId: uploaded.manifestId,
      bitrateKbps: output.measuredBitrateKbps,
      maxBitrateKbps: output.maxBitrateKbps,
      sourcePassthrough: false,
      bytes: uploaded.bytes,
      duration: output.duration,
      mimeType: "audio/mp4",
      container: "m4a",
      codec: "aac",
      localPath: output.outputPath,
    });
  }
  return renditions.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);
}

export function preferredAudioRendition(
  renditions: UploadedAudioLadderRendition[],
): UploadedAudioLadderRendition {
  const selected =
    renditions.find((rendition) => rendition.tier === "standard") ??
    renditions.find((rendition) => rendition.tier === "data_saver") ??
    renditions.find((rendition) => rendition.tier === "high");
  if (!selected) throw new Error("audio delivery ladder produced no rendition");
  return selected;
}
