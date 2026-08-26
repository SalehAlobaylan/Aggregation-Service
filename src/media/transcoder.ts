/**
 * Media Transcoder
 * FFmpeg-based video/audio transcoding and thumbnail extraction
 */
import { join } from "path";
import { mkdir, readdir, stat, writeFile, readFile } from "fs/promises";
import { createHash } from "crypto";
import { config } from "../config/index.js";
import { logger } from "../observability/logger.js";
import { runManagedProcess } from "../runtime/managed-process.js";

export interface MediaInfo {
  duration: number;
  width?: number;
  height?: number;
  format: string;
  hasVideo: boolean;
  hasAudio: boolean;
  bitrateKbps?: number;
  videoCodec?: string;
  audioCodec?: string;
  visualAvailable: boolean;
  audioChannels?: number;
  audioSampleRate?: number;
  videoProfile?: string;
  videoLevel?: string;
  pixelFormat?: string;
  frameRate?: number;
  audioBitrateKbps?: number;
  startTime?: number;
  seekable?: boolean;
  rotation?: number;
  displayAspectRatio?: string;
  colorSpace?: string;
  normalizedMime?: string;
  probeDigest?: string;
  streams?: Array<Record<string, unknown>>;
}

export interface TranscodeResult {
  outputPath: string;
  duration: number;
}

export interface DeliveryOutput extends TranscodeResult {
  info: MediaInfo;
}

export type AudioQualityTier = "data_saver" | "standard" | "high";

export const AUDIO_QUALITY_CEILINGS_KBPS: Readonly<
  Record<AudioQualityTier, number>
> = {
  data_saver: 64,
  standard: 128,
  high: 192,
};

export interface AudioLadderEncodeSpec {
  tier: AudioQualityTier;
  targetBitrateKbps: number;
  maxBitrateKbps: number;
  outputPath: string;
}

export interface AudioLadderPlan {
  /** The source may serve directly only when its measured bitrate fits a tier. */
  sourceTier?: AudioQualityTier;
  sourceBitrateKbps?: number;
  encode: Array<Omit<AudioLadderEncodeSpec, "outputPath">>;
}

export interface AudioLadderOutput extends DeliveryOutput {
  tier: AudioQualityTier;
  targetBitrateKbps: number;
  maxBitrateKbps: number;
  measuredBitrateKbps: number;
}

export interface FfmpegRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const AUDIO_TIERS: AudioQualityTier[] = ["data_saver", "standard", "high"];

/**
 * Plans strict quality ceilings without manufacturing higher-bitrate copies of
 * a lower-quality source. Distinct required outputs are encoded together by
 * `transcodeAudioLadderToM4a`; equal targets are deliberately collapsed.
 */
export function planAudioDeliveryLadder(
  sourceBitrateKbps: number | undefined,
  allowSourcePassthrough: boolean,
): AudioLadderPlan {
  const measured =
    sourceBitrateKbps != null &&
    Number.isFinite(sourceBitrateKbps) &&
    sourceBitrateKbps > 0
      ? Math.max(8, Math.floor(sourceBitrateKbps))
      : undefined;
  if (measured == null) {
    // A missing measurement cannot prove that even 64 kbps is not an
    // up-bitrate. resolveAudioBitrateKbps performs a lazy packet-size fallback;
    // if that also fails, generation must fail closed rather than fabricate a
    // tier contract.
    return { encode: [] };
  }

  const naturalTier = AUDIO_TIERS.find(
    (tier) => measured <= AUDIO_QUALITY_CEILINGS_KBPS[tier],
  );
  const sourceTier = allowSourcePassthrough ? naturalTier : undefined;
  const encoded = new Map<number, Omit<AudioLadderEncodeSpec, "outputPath">>();

  for (const tier of AUDIO_TIERS) {
    const ceiling = AUDIO_QUALITY_CEILINGS_KBPS[tier];
    if (sourceTier === tier) break;
    if (sourceTier && ceiling >= measured) break;
    const target = Math.min(measured, ceiling);
    if (target <= 0 || encoded.has(target)) continue;
    encoded.set(target, {
      tier,
      targetBitrateKbps: target,
      maxBitrateKbps: ceiling,
    });
    if (target === measured) break;
  }

  return {
    sourceTier,
    sourceBitrateKbps: measured,
    encode: [...encoded.values()],
  };
}

/**
 * EncodeProfile drives `transcodeToMp4`. The Quality Management System lets
 * admins create named profiles in CMS; the worker resolves them and passes
 * the parameters here. When `undefined` is supplied, DEFAULT_ENCODE_PROFILE
 * is used (matches the historical hard-coded recipe).
 */
export interface EncodeProfile {
  videoCodec: "h264" | "h265" | "av1";
  /** 0 = no resolution cap. Always downscale-only — never upscale a small input. */
  maxHeight: number;
  /** kbps target. 0 = use CRF mode instead. */
  targetBitrateKbps: number;
  crf: number;
  preset: string;
  audioCodec: "aac" | "opus";
  audioBitrateKbps: number;
}

export const DEFAULT_ENCODE_PROFILE: EncodeProfile = {
  videoCodec: "h264",
  maxHeight: 0,
  targetBitrateKbps: 0,
  crf: 23,
  preset: "fast",
  audioCodec: "aac",
  audioBitrateKbps: 128,
};

// Used only when CMS profile resolution is unavailable. It is deliberately a
// named safe fallback instead of the historic uncapped fail-open recipe.
export const SAFE_FALLBACK_ENCODE_PROFILE: EncodeProfile = {
  ...DEFAULT_ENCODE_PROFILE,
  maxHeight: 720,
};

// Media workers run alongside every other BullMQ lane in one Node process.
// Leaving x264 at its automatic thread count lets two encodes create hundreds
// of runnable threads on a developer machine, starving BullMQ lock renewal and
// stalling unrelated queues. Keep each encode bounded; worker concurrency still
// provides parallelism across media items.
export const FFMPEG_TRANSCODE_THREADS = 2;
const MEDIA_COMMAND_NO_PROGRESS_TIMEOUT_MS = 5 * 60_000;

function videoCodecFlag(codec: EncodeProfile["videoCodec"]): string {
  switch (codec) {
    case "h265":
      return "libx265";
    case "av1":
      return "libaom-av1";
    case "h264":
    default:
      return "libx264";
  }
}

function audioCodecFlag(codec: EncodeProfile["audioCodec"]): string {
  return codec === "opus" ? "libopus" : "aac";
}

/**
 * Build the FFmpeg outputOptions array for a given encode profile. Pulled out
 * so it can be shared between bounded visual encode operations, and so it is
 * unit-testable without booting ffmpeg.
 */
export function buildEncodeOptions(profile: EncodeProfile): string[] {
  const opts: string[] = [];
  opts.push(`-c:v ${videoCodecFlag(profile.videoCodec)}`);
  opts.push(`-preset ${profile.preset}`);
  opts.push(`-threads ${FFMPEG_TRANSCODE_THREADS}`, "-filter_threads 1");

  // Keep mobile compatibility for h264. h265/av1 ignore profile:baseline.
  if (profile.videoCodec === "h264") {
    opts.push("-profile:v baseline", "-level 3.0");
  }

  if (profile.targetBitrateKbps > 0) {
    const k = profile.targetBitrateKbps;
    opts.push(
      `-b:v ${k}k`,
      `-maxrate ${Math.round(k * 1.5)}k`,
      `-bufsize ${k * 2}k`,
    );
  } else {
    opts.push(`-crf ${profile.crf}`);
  }

  if (profile.maxHeight > 0) {
    // Downscale-only: only shrink if the input is taller than the cap.
    // -2 keeps the width even (required by yuv420p). Using force_original_aspect_ratio=decrease
    // is the cleanest "fit inside" for arbitrary input aspect ratios.
    opts.push(`-vf scale=-2:'min(${profile.maxHeight},ih)'`);
  }

  opts.push(`-c:a ${audioCodecFlag(profile.audioCodec)}`);
  opts.push(`-b:a ${profile.audioBitrateKbps}k`);
  opts.push("-movflags +faststart", "-pix_fmt yuv420p");
  return opts;
}

async function measureAudioPacketBitrateKbps(
  inputPath: string,
  duration: number,
  options: FfmpegRunOptions,
): Promise<number | undefined> {
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  let remainder = "";
  let bytes = 0;
  let stderr = "";
  const consume = (value: string) => {
    for (const line of value.split(/\r?\n/)) {
      const packetBytes = Number(line.trim());
      if (Number.isFinite(packetBytes) && packetBytes > 0) bytes += packetBytes;
    }
  };
  const result = await runManagedProcess({
    label: "ffprobe",
    args: [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "packet=size",
      "-of",
      "csv=p=0",
      inputPath,
    ],
    timeoutMs: options.timeoutMs ?? config.mediaJobTimeoutMs,
    noProgressTimeoutMs: MEDIA_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    signal: options.signal,
    onStdout: (chunk) => {
      const value = remainder + chunk.toString();
      const boundary = value.lastIndexOf("\n");
      if (boundary < 0) {
        remainder = value;
        return;
      }
      consume(value.slice(0, boundary));
      remainder = value.slice(boundary + 1);
    },
    onStderr: (chunk) => {
      stderr += chunk.toString();
    },
  });
  consume(remainder);
  if (result.code !== 0)
    throw new Error(
      `ffprobe audio bitrate measurement failed: ${stderr.slice(-1024)}`,
    );
  return bytes > 0
    ? Math.max(1, Math.floor((bytes * 8) / duration / 1000))
    : undefined;
}

const audioBitrateMeasurements = new WeakMap<
  MediaInfo,
  Promise<number | undefined>
>();

/** Resolve an exact source-audio average only when delivery tiers need it.
 * The canonical probe stays fast for hidden long parents, while chapter loops
 * reuse the same source measurement instead of rescanning once per unit. */
export function resolveAudioBitrateKbps(
  inputPath: string,
  info: MediaInfo,
  options: FfmpegRunOptions = {},
): Promise<number | undefined> {
  if (info.audioBitrateKbps != null)
    return Promise.resolve(info.audioBitrateKbps);
  const existing = audioBitrateMeasurements.get(info);
  if (existing) return existing;
  const measurement = measureAudioPacketBitrateKbps(
    inputPath,
    info.duration,
    options,
  );
  audioBitrateMeasurements.set(info, measurement);
  return measurement;
}

/**
 * Get media file information using ffprobe.
 * Returns container bitrate (when reported) so the Quality system can project
 * post-re-encode size without downloading the file twice.
 */
export async function getMediaInfo(
  inputPath: string,
  options: FfmpegRunOptions = {},
): Promise<MediaInfo> {
  let stdout = "";
  let stderr = "";
  const result = await runManagedProcess({
    label: "ffprobe",
    args: [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      inputPath,
    ],
    timeoutMs: options.timeoutMs ?? Math.min(config.mediaJobTimeoutMs, 60_000),
    noProgressTimeoutMs: MEDIA_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    signal: options.signal,
    onStdout: (chunk) => {
      stdout += chunk.toString();
    },
    onStderr: (chunk) => {
      stderr += chunk.toString();
    },
  });
  if (result.code !== 0)
    throw new Error(
      `ffprobe exited with code ${result.code}: ${stderr.slice(-2048)}`,
    );
  let metadata: {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      codec_name?: string;
      profile?: string;
      level?: number;
      pix_fmt?: string;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      bit_rate?: string | number;
      channels?: number;
      sample_rate?: string;
      start_time?: string | number;
      display_aspect_ratio?: string;
      color_space?: string;
      tags?: Record<string, string>;
      disposition?: { attached_pic?: number };
    }>;
    format?: {
      duration?: string | number;
      format_name?: string;
      format_long_name?: string;
      bit_rate?: string | number;
      start_time?: string | number;
    };
  };
  try {
    metadata = JSON.parse(stdout) as typeof metadata;
  } catch {
    throw new Error("ffprobe returned invalid JSON");
  }
  const streams = metadata.streams ?? [];
  // Album art is a video stream in ffprobe, but it is not visual media.
  const videoStream = streams.find(
    (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1,
  );
  const audioStream = streams.find((s) => s.codec_type === "audio");
  const fmtBitrate = metadata.format?.bit_rate;
  const durationRaw = metadata.format?.duration;
  const duration =
    typeof durationRaw === "string" ? Number(durationRaw) : (durationRaw ?? 0);
  const bitrateBps =
    typeof fmtBitrate === "string" ? parseInt(fmtBitrate, 10) : fmtBitrate;
  const bitrateKbps =
    typeof bitrateBps === "number" &&
    Number.isFinite(bitrateBps) &&
    bitrateBps > 0
      ? Math.round(bitrateBps / 1000)
      : undefined;
  const streamAudioBitrate = audioStream?.bit_rate
    ? Math.floor(Number(audioStream.bit_rate) / 1000)
    : undefined;
  const measuredAudioBitrate =
    streamAudioBitrate && Number.isFinite(streamAudioBitrate)
      ? streamAudioBitrate
      : undefined;
  const parseRate = (value?: string) => {
    if (!value) return undefined;
    const [numerator, denominator] = value.split("/").map(Number);
    const rate = denominator ? numerator / denominator : numerator;
    return Number.isFinite(rate) && rate > 0 ? rate : undefined;
  };
  const rotation = Number(videoStream?.tags?.rotate ?? 0);
  const formatName = metadata.format?.format_name || "unknown";
  const normalizedMime =
    formatName.includes("mp4") || formatName.includes("mov")
      ? videoStream
        ? "video/mp4"
        : "audio/mp4"
      : formatName.includes("mp3")
        ? "audio/mpeg"
        : formatName.includes("ogg")
          ? "audio/ogg"
          : formatName.includes("webm")
            ? videoStream
              ? "video/webm"
              : "audio/webm"
            : undefined;
  const snapshot = {
    format: formatName,
    duration,
    streams,
    start_time: metadata.format?.start_time,
  };
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: videoStream?.width,
    height: videoStream?.height,
    format: formatName,
    hasVideo: !!videoStream,
    hasAudio: !!audioStream,
    bitrateKbps,
    videoCodec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    visualAvailable: !!videoStream,
    audioChannels: audioStream?.channels,
    audioSampleRate: audioStream?.sample_rate
      ? Number(audioStream.sample_rate)
      : undefined,
    videoProfile: videoStream?.profile,
    videoLevel:
      videoStream?.level != null ? String(videoStream.level) : undefined,
    pixelFormat: videoStream?.pix_fmt,
    frameRate:
      parseRate(videoStream?.avg_frame_rate) ??
      parseRate(videoStream?.r_frame_rate),
    audioBitrateKbps: measuredAudioBitrate,
    startTime: Number(
      metadata.format?.start_time ?? videoStream?.start_time ?? 0,
    ),
    seekable: Number.isFinite(duration) && duration > 0,
    rotation: Number.isFinite(rotation) ? rotation : undefined,
    displayAspectRatio: videoStream?.display_aspect_ratio,
    colorSpace: videoStream?.color_space,
    normalizedMime,
    probeDigest: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
    streams: streams.map((stream) => ({ ...stream })),
  };
}

function assertDeliveryOutput(
  info: MediaInfo,
  kind: "audio" | "progressive",
  expectedDuration?: number,
): void {
  if (!info.hasAudio || info.duration <= 0 || info.seekable === false)
    throw new Error("delivery output is not seekable audio media");
  if (
    expectedDuration &&
    Math.abs(info.duration - expectedDuration) >
      Math.max(2, expectedDuration * 0.02)
  )
    throw new Error("delivery output duration drift exceeds contract");
  if (
    kind === "audio" &&
    (info.visualAvailable ||
      info.normalizedMime !== "audio/mp4" ||
      info.audioCodec !== "aac")
  )
    throw new Error("delivery audio must be AAC-LC M4A without video");
  if (
    kind === "progressive" &&
    (!info.visualAvailable ||
      info.normalizedMime !== "video/mp4" ||
      info.videoCodec !== "h264" ||
      info.audioCodec !== "aac" ||
      info.pixelFormat !== "yuv420p" ||
      (info.frameRate ?? 30) > 30)
  )
    throw new Error("progressive output fails browser delivery contract");
}

async function runDeliveryFfmpeg(
  args: string[],
  outputPath: string,
  kind: "audio" | "progressive",
  expectedDuration?: number,
  options: FfmpegRunOptions = {},
): Promise<DeliveryOutput> {
  let stderr = "";
  const result = await runManagedProcess({
    label: "ffmpeg",
    args,
    timeoutMs: options.timeoutMs ?? config.mediaJobTimeoutMs,
    noProgressTimeoutMs: MEDIA_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    signal: options.signal,
    onStderr: (chunk) => {
      stderr += chunk.toString();
    },
  });
  if (result.code !== 0)
    throw new Error(`ffmpeg delivery output failed: ${stderr.slice(-2048)}`);
  const info = await getMediaInfo(outputPath, options);
  assertDeliveryOutput(info, kind, expectedDuration);
  return { outputPath, duration: info.duration, info };
}

export async function transcodeAudioToM4a(
  inputPath: string,
  outputPath: string,
  options: FfmpegRunOptions = {},
): Promise<DeliveryOutput> {
  const input = await getMediaInfo(inputPath, options);
  const measuredInputBitrate = await resolveAudioBitrateKbps(
    inputPath,
    input,
    options,
  );
  if (measuredInputBitrate == null)
    throw new Error("audio transcode requires an exact source bitrate");
  const [result] = await transcodeAudioLadderToM4a(
    inputPath,
    [
      {
        tier: "standard",
        targetBitrateKbps: Math.min(
          measuredInputBitrate,
          AUDIO_QUALITY_CEILINGS_KBPS.standard,
        ),
        maxBitrateKbps: AUDIO_QUALITY_CEILINGS_KBPS.standard,
        outputPath,
      },
    ],
    { ...options, inputInfo: input },
  );
  return result;
}

/**
 * Decode one source audio stream once and fan it out to every required M4A
 * ceiling in one supervised FFmpeg process. The output probe is authoritative:
 * no caller may label an artifact with a tier that its measured stream exceeds.
 */
export async function transcodeAudioLadderToM4a(
  inputPath: string,
  outputs: AudioLadderEncodeSpec[],
  options: FfmpegRunOptions & {
    inputInfo?: MediaInfo;
    startSec?: number;
    durationSec?: number;
  } = {},
): Promise<AudioLadderOutput[]> {
  if (outputs.length === 0) return [];
  const seenPaths = new Set<string>();
  const seenTiers = new Set<AudioQualityTier>();
  for (const output of outputs) {
    if (
      seenPaths.has(output.outputPath) ||
      seenTiers.has(output.tier) ||
      output.targetBitrateKbps <= 0 ||
      output.targetBitrateKbps > output.maxBitrateKbps ||
      output.maxBitrateKbps !== AUDIO_QUALITY_CEILINGS_KBPS[output.tier]
    ) {
      throw new Error("invalid or duplicate audio ladder output specification");
    }
    seenPaths.add(output.outputPath);
    seenTiers.add(output.tier);
  }
  const input = options.inputInfo ?? (await getMediaInfo(inputPath, options));
  if (!input.hasAudio)
    throw new Error("audio ladder input has no audio stream");
  const measuredInputBitrate = await resolveAudioBitrateKbps(
    inputPath,
    input,
    options,
  );
  if (measuredInputBitrate == null)
    throw new Error("audio ladder input has no exact bitrate measurement");
  const expectedDuration =
    options.durationSec != null
      ? Math.max(0.1, options.durationSec)
      : input.duration;
  const args = ["-y"];
  if (options.startSec != null)
    args.push("-ss", String(Math.max(0, options.startSec)));
  args.push("-i", inputPath);
  for (const output of outputs) {
    args.push(
      "-map",
      "0:a:0",
      "-vn",
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-b:a",
      `${output.targetBitrateKbps}k`,
      "-ac",
      "2",
      "-ar",
      "48000",
      "-threads",
      String(FFMPEG_TRANSCODE_THREADS),
      "-movflags",
      "+faststart",
    );
    if (options.durationSec != null) args.push("-t", String(expectedDuration));
    args.push(output.outputPath);
  }
  let stderr = "";
  const execution = await runManagedProcess({
    label: "ffmpeg",
    args,
    timeoutMs: options.timeoutMs ?? config.mediaJobTimeoutMs,
    noProgressTimeoutMs: MEDIA_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    signal: options.signal,
    onStderr: (chunk) => {
      stderr += chunk.toString();
    },
  });
  if (execution.code !== 0)
    throw new Error(`audio ladder encode failed: ${stderr.slice(-2048)}`);

  const verified: AudioLadderOutput[] = [];
  for (const output of outputs) {
    const info = await getMediaInfo(output.outputPath, options);
    assertDeliveryOutput(info, "audio", expectedDuration);
    const measured = await resolveAudioBitrateKbps(
      output.outputPath,
      info,
      options,
    );
    if (measured == null || measured <= 0)
      throw new Error(
        `audio ladder output has no measured bitrate: ${output.tier}`,
      );
    if (measured > output.maxBitrateKbps)
      throw new Error(
        `audio ladder ${output.tier} exceeds ${output.maxBitrateKbps} kbps ceiling (${measured} kbps)`,
      );
    if (
      measuredInputBitrate != null &&
      output.targetBitrateKbps > measuredInputBitrate
    )
      throw new Error(`audio ladder attempted to up-bitrate ${output.tier}`);
    verified.push({
      outputPath: output.outputPath,
      duration: info.duration,
      info,
      tier: output.tier,
      targetBitrateKbps: output.targetBitrateKbps,
      maxBitrateKbps: output.maxBitrateKbps,
      measuredBitrateKbps: measured,
    });
  }
  return verified;
}

export async function remuxToMp4(
  inputPath: string,
  outputPath: string,
  options: FfmpegRunOptions = {},
): Promise<DeliveryOutput> {
  const input = await getMediaInfo(inputPath, options);
  return runDeliveryFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    outputPath,
    "progressive",
    input.duration,
    options,
  );
}

export async function transcodeProgressive(
  inputPath: string,
  outputPath: string,
  profile: EncodeProfile = SAFE_FALLBACK_ENCODE_PROFILE,
  maxHeight?: number,
  options: FfmpegRunOptions = {},
): Promise<DeliveryOutput> {
  const input = await getMediaInfo(inputPath, options);
  const configuredHeight = maxHeight ?? profile.maxHeight;
  const height = Math.min(configuredHeight || 720, input.height ?? 720);
  const bitrate =
    profile.targetBitrateKbps > 0
      ? [
          "-b:v",
          `${profile.targetBitrateKbps}k`,
          "-maxrate",
          `${Math.round(profile.targetBitrateKbps * 1.25)}k`,
          "-bufsize",
          `${profile.targetBitrateKbps * 2}k`,
        ]
      : ["-crf", String(profile.crf)];
  return runDeliveryFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c:v",
      "libx264",
      "-profile:v",
      "main",
      "-pix_fmt",
      "yuv420p",
      "-r:v",
      "30",
      "-preset",
      profile.preset,
      ...bitrate,
      "-vf",
      `scale=-2:'min(${height},ih)':force_original_aspect_ratio=decrease`,
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-b:a",
      `${profile.audioBitrateKbps || 128}k`,
      "-ac",
      "2",
      "-ar",
      "48000",
      "-threads",
      String(FFMPEG_TRANSCODE_THREADS),
      "-filter_threads",
      "1",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    outputPath,
    "progressive",
    input.duration,
    options,
  );
}

/** Managed auxiliary output with the same abort/timeout process-group rules as delivery encodes. */
async function runAuxiliaryFfmpeg(
  label: string,
  args: string[],
  outputPath: string,
  options: FfmpegRunOptions,
): Promise<string> {
  let stderr = "";
  const result = await runManagedProcess({
    label: "ffmpeg",
    args,
    timeoutMs: options.timeoutMs ?? config.mediaJobTimeoutMs,
    noProgressTimeoutMs: MEDIA_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    signal: options.signal,
    onStderr: (chunk) => {
      stderr += chunk.toString();
    },
  });
  if (result.code !== 0)
    throw new Error(`${label} FFmpeg failed: ${stderr.slice(-2048)}`);
  const output = await stat(outputPath);
  if (!output.isFile() || output.size <= 0)
    throw new Error(`${label} created no output`);
  return outputPath;
}

async function cutDeliverySegment(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
  profile: EncodeProfile | undefined,
  options: FfmpegRunOptions,
): Promise<TranscodeResult> {
  const expectedDuration = Math.max(0.1, durationSec);
  const args = [
    "-y",
    "-ss",
    String(Math.max(0, startSec)),
    "-i",
    inputPath,
    "-t",
    String(expectedDuration),
  ];
  const resolved = profile ?? SAFE_FALLBACK_ENCODE_PROFILE;
  const input = await getMediaInfo(inputPath, options);
  const height = Math.min(resolved.maxHeight || 720, input.height ?? 720);
  const bitrate =
    resolved.targetBitrateKbps > 0
      ? [
          "-b:v",
          `${resolved.targetBitrateKbps}k`,
          "-maxrate",
          `${Math.round(resolved.targetBitrateKbps * 1.25)}k`,
          "-bufsize",
          `${resolved.targetBitrateKbps * 2}k`,
        ]
      : ["-crf", String(resolved.crf)];
  args.push(
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "libx264",
    "-profile:v",
    "main",
    "-pix_fmt",
    "yuv420p",
    "-r:v",
    "30",
    "-preset",
    resolved.preset,
    ...bitrate,
    "-vf",
    `scale=-2:'min(${height},ih)':force_original_aspect_ratio=decrease`,
    "-c:a",
    "aac",
    "-profile:a",
    "aac_low",
    "-b:a",
    `${resolved.audioBitrateKbps || 128}k`,
    "-ac",
    "2",
    "-ar",
    "48000",
    "-threads",
    String(FFMPEG_TRANSCODE_THREADS),
    "-filter_threads",
    "1",
    "-movflags",
    "+faststart",
    outputPath,
  );
  const output = await runDeliveryFfmpeg(
    args,
    outputPath,
    "progressive",
    expectedDuration,
    options,
  );
  return { outputPath: output.outputPath, duration: output.duration };
}

/**
 * Transcode video to MP4 using the supplied encode profile (or the default).
 */
export function transcodeToMp4(
  inputPath: string,
  outputPath: string,
  profile: EncodeProfile = DEFAULT_ENCODE_PROFILE,
  options: FfmpegRunOptions = {},
): Promise<TranscodeResult> {
  return transcodeProgressive(
    inputPath,
    outputPath,
    profile,
    profile.maxHeight || 720,
    options,
  ).then((result) => ({
    outputPath: result.outputPath,
    duration: result.duration,
  }));
}

/**
 * Extract thumbnail from video at the specified offset.
 *
 * `maxHeight` caps the thumbnail height (preserving aspect ratio); the
 * default 360 matches the historical hardcoded behaviour. `offsetSeconds`
 * picks the timecode to grab — values larger than the clip's duration cause
 * ffmpeg to fall back to the last keyframe.
 *
 * Writes to the exact outputPath provided (safe for concurrent jobs).
 */
export function extractThumbnail(
  inputPath: string,
  outputPath: string,
  offsetSeconds: number = 2,
  maxHeight: number = 360,
  options: FfmpegRunOptions = {},
): Promise<string> {
  return runAuxiliaryFfmpeg(
    "thumbnail",
    [
      "-y",
      "-ss",
      String(Math.max(0, offsetSeconds)),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      maxHeight > 0 ? `scale=-2:'min(${maxHeight},ih)'` : "scale=-2:360",
      "-threads",
      String(FFMPEG_TRANSCODE_THREADS),
      "-filter_threads",
      "1",
      outputPath,
    ],
    outputPath,
    options,
  );
}

/**
 * Map an output_container profile value to its file extension.
 * Restricted to single-file containers; HLS / DASH would emit a manifest +
 * segments and need a different upload path.
 */
export function containerExtension(container: string | undefined): string {
  switch ((container ?? "mp4").toLowerCase()) {
    case "webm":
      return "webm";
    case "mov":
      return "mov";
    case "mp4":
    default:
      return "mp4";
  }
}

/**
 * Map an output_container profile value to its MIME type.
 */
export function containerMime(container: string | undefined): string {
  switch ((container ?? "mp4").toLowerCase()) {
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "mp4":
    default:
      return "video/mp4";
  }
}

/**
 * Extract audio from video file
 */
export function extractAudio(
  inputPath: string,
  outputPath: string,
  options: FfmpegRunOptions = {},
): Promise<string> {
  return transcodeAudioToM4a(inputPath, outputPath, options).then(
    (result) => result.outputPath,
  );
}

export function cutMediaSegment(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
  profile: EncodeProfile = DEFAULT_ENCODE_PROFILE,
  options: FfmpegRunOptions = {},
): Promise<TranscodeResult> {
  return cutDeliverySegment(
    inputPath,
    outputPath,
    startSec,
    durationSec,
    profile,
    options,
  );
}

export interface AdaptiveHlsResult {
  masterPlaylistPath: string;
  progressiveFallbackPath: string;
  variants: Array<{
    height: number;
    width: number;
    bitrateKbps: number;
    playlist: string;
  }>;
  audioPlaylist: string;
  duration: number;
}

/**
 * A capped master is a small access surface over the immutable package, not a
 * new encode. It deliberately references the same audio group and CMAF media
 * objects, so the mobile quality ceiling is enforceable without duplicating
 * storage or CPU work.
 */
export async function createHlsAccessMaster(
  outputDir: string,
  variants: AdaptiveHlsResult["variants"],
  tier: "standard" | "high",
): Promise<{ file: string; maxHeight: number; maxBandwidthKbps: number }> {
  const selected = variants.filter(
    (variant) => tier === "high" || variant.height <= 540,
  );
  if (selected.length < 2)
    throw new Error(
      `${tier} HLS access master requires at least two legal variants`,
    );
  const file = `${tier}.m3u8`;
  const master =
    [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="AAC",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"',
      ...selected.map(
        (variant) =>
          `#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil(variant.bitrateKbps * 1100)},AVERAGE-BANDWIDTH=${variant.bitrateKbps * 1000},CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=${variant.width}x${variant.height},AUDIO="audio"\n${variant.playlist}`,
      ),
    ].join("\n") + "\n";
  await writeFile(join(outputDir, file), master);
  return {
    file,
    maxHeight: Math.max(...selected.map((variant) => variant.height)),
    maxBandwidthKbps: Math.max(
      ...selected.map((variant) => variant.bitrateKbps),
    ),
  };
}

/**
 * Produces an actual CMAF VOD package. A single FFmpeg process decodes once,
 * emits a shared audio group and aligned visual ladders. The progressive
 * fallback is made once by the delivery route before package creation; doing
 * it here would create a second H.264 encoder and violate the resource bound.
 */
export async function createAdaptiveHlsPackage(
  inputPath: string,
  outputDir: string,
  options: FfmpegRunOptions = {},
): Promise<AdaptiveHlsResult> {
  const probe = await getMediaInfo(inputPath, options);
  if (!probe.visualAvailable || !probe.hasAudio)
    throw new Error("adaptive HLS requires meaningful video and audio");
  const heights = [360, 540, 720].filter((h) => h <= (probe.height ?? 0));
  if (heights.length < 2)
    throw new Error(
      "adaptive HLS requires at least two legal source-bounded variants",
    );
  await mkdir(outputDir, { recursive: true });
  const bitrate = new Map([
    [360, 600],
    [540, 1200],
    [720, 2500],
  ]);
  // One split is important: each branch receives the same decoded frames.
  // The per-output `-r 30` below only drops frames when necessary; it never
  // scales a source up and keeping the graph single-pass prevents three
  // independent decoders from exhausting a local worker.
  const filter =
    `[0:v]split=${heights.length}${heights.map((_, index) => `[v${index}]`).join("")};` +
    heights
      .map(
        (h, index) =>
          `[v${index}]scale=-2:'min(${h},ih)':force_original_aspect_ratio=decrease[out${index}]`,
      )
      .join(";");
  const args = [
    "-y",
    "-i",
    inputPath,
    "-filter_complex",
    filter,
    "-threads",
    String(FFMPEG_TRANSCODE_THREADS),
    "-filter_threads",
    "1",
  ];
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i]!;
    const kbps = bitrate.get(h)!;
    args.push(
      "-map",
      `[out${i}]`,
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "main",
      "-preset",
      "fast",
      "-r:v",
      "30",
      "-b:v",
      `${kbps}k`,
      "-maxrate",
      `${Math.round(kbps * 1.07)}k`,
      "-bufsize",
      `${kbps * 2}k`,
      "-g",
      "180",
      "-keyint_min",
      "180",
      "-sc_threshold",
      "0",
      "-force_key_frames",
      "expr:gte(t,n_forced*6)",
      "-f",
      "hls",
      "-hls_segment_type",
      "fmp4",
      "-hls_time",
      "6",
      "-hls_playlist_type",
      "vod",
      "-hls_fmp4_init_filename",
      `v${h}_init.mp4`,
      "-hls_segment_filename",
      join(outputDir, `v${h}_%03d.m4s`),
      join(outputDir, `v${h}.m3u8`),
    );
  }
  args.push(
    "-map",
    "0:a:0",
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-f",
    "hls",
    "-hls_segment_type",
    "fmp4",
    "-hls_time",
    "6",
    "-hls_playlist_type",
    "vod",
    "-hls_fmp4_init_filename",
    "audio_init.mp4",
    "-hls_segment_filename",
    join(outputDir, "audio_%03d.m4s"),
    join(outputDir, "audio.m3u8"),
  );
  let stderr = "";
  const result = await runManagedProcess({
    label: "ffmpeg",
    args,
    timeoutMs: options.timeoutMs ?? config.mediaJobTimeoutMs,
    noProgressTimeoutMs: MEDIA_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    signal: options.signal,
    onStderr: (chunk) => {
      stderr += chunk.toString();
    },
  });
  if (result.code !== 0)
    throw new Error(`adaptive HLS FFmpeg failed: ${stderr.slice(-2048)}`);
  // Generate master attributes from produced artifacts, not target-rung
  // guesses. The package validator independently remeasures them before
  // activation, but the playlist itself must never claim a larger ladder.
  const variants = await Promise.all(
    heights.map(async (h) => {
      const playlist = `v${h}.m3u8`;
      const raw = await readFile(join(outputDir, playlist), "utf8");
      const duration = [...raw.matchAll(/#EXTINF:([0-9.]+)/g)].reduce(
        (sum, match) => sum + Number(match[1]),
        0,
      );
      const segments = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.endsWith(".m4s"));
      const bytes = (
        await Promise.all(
          segments.map((segment) =>
            stat(join(outputDir, segment)).then((entry) => entry.size),
          ),
        )
      ).reduce((sum, size) => sum + size, 0);
      const produced = await getMediaInfo(join(outputDir, playlist), options);
      const averageKbps =
        duration > 0
          ? Math.max(1, Math.ceil((bytes * 8) / duration / 1000))
          : bitrate.get(h)!;
      return {
        height: produced.height ?? h,
        width:
          produced.width ??
          Math.round(
            (((probe.width ?? 16) / Math.max(1, probe.height ?? 9)) * h) / 2,
          ) * 2,
        bitrateKbps: averageKbps,
        playlist,
      };
    }),
  );
  const master =
    [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="AAC",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"',
      ...variants.map(
        (v) =>
          `#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil(v.bitrateKbps * 1100)},AVERAGE-BANDWIDTH=${v.bitrateKbps * 1000},CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=${v.width}x${v.height},AUDIO="audio"\n${v.playlist}`,
      ),
    ].join("\n") + "\n";
  const masterPlaylistPath = join(outputDir, "master.m3u8");
  await writeFile(masterPlaylistPath, master);

  // Reuse the already encoded 360p CMAF branch for the Data Saver MP4.
  // This is a stream-copy mux, so it does not start another video encoder.
  const lowest = [...variants].sort(
    (left, right) => left.height - right.height,
  )[0]!;
  const progressiveFallbackPath = join(outputDir, "fallback.mp4");
  let fallbackStderr = "";
  const fallbackResult = await runManagedProcess({
    label: "ffmpeg",
    args: [
      "-y",
      "-i",
      join(outputDir, lowest.playlist),
      "-i",
      join(outputDir, "audio.m3u8"),
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      progressiveFallbackPath,
    ],
    timeoutMs: options.timeoutMs ?? config.mediaJobTimeoutMs,
    noProgressTimeoutMs: MEDIA_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    signal: options.signal,
    onStderr: (chunk) => {
      fallbackStderr += chunk.toString();
    },
  });
  if (fallbackResult.code !== 0)
    throw new Error(
      `Data Saver progressive mux failed: ${fallbackStderr.slice(-2048)}`,
    );
  const fallbackProbe = await getMediaInfo(progressiveFallbackPath, options);
  assertDeliveryOutput(fallbackProbe, "progressive", probe.duration);
  if ((fallbackProbe.height ?? 0) > 360)
    throw new Error("Data Saver progressive exceeds 360p");
  return {
    masterPlaylistPath,
    progressiveFallbackPath,
    variants,
    audioPlaylist: "audio.m3u8",
    duration: probe.duration,
  };
}

export async function validateAdaptiveHlsPackage(outputDir: string): Promise<{
  files: string[];
  playlistCount: number;
  evidence: Record<string, unknown>;
}> {
  const files = await readdir(outputDir);
  const playlists = files.filter((file) => file.endsWith(".m3u8"));
  if (!files.includes("master.m3u8") || playlists.length < 4)
    throw new Error("adaptive HLS package is incomplete");
  const timeline: Record<string, number> = {};
  const probes: Record<string, unknown> = {};
  const keyframes: Record<string, unknown> = {};
  for (const playlist of playlists) {
    const raw = await readFile(join(outputDir, playlist), "utf8");
    if (
      !raw.startsWith("#EXTM3U") ||
      raw.includes("..") ||
      /^https?:/m.test(raw) ||
      /URI="(?:\/|\\)/.test(raw)
    )
      throw new Error(`unsafe HLS playlist ${playlist}`);
    const refs = [
      ...raw
        .split("\n")
        .map((v) => v.trim())
        .filter((v) => v && !v.startsWith("#")),
      ...[...raw.matchAll(/URI="([^"]+)"/g)].map((match) => match[1]!),
    ];
    const unique = new Set<string>();
    for (const ref of refs) {
      if (
        ref.includes("..") ||
        ref.startsWith("/") ||
        ref.includes("\\") ||
        unique.has(ref)
      )
        throw new Error(`unsafe or duplicate HLS reference ${playlist}:${ref}`);
      unique.add(ref);
      if (!files.includes(ref))
        throw new Error(`HLS playlist ${playlist} references missing ${ref}`);
      if ((await stat(join(outputDir, ref))).size === 0)
        throw new Error(`HLS package contains empty ${ref}`);
    }
    const durations = [...raw.matchAll(/#EXTINF:([0-9.]+)/g)].map((match) =>
      Number(match[1]),
    );
    if (
      durations.some(
        (value) => !Number.isFinite(value) || value <= 0 || value > 7,
      )
    )
      throw new Error(`invalid CMAF timeline in ${playlist}`);
    if (durations.length)
      timeline[playlist] = durations.reduce((total, value) => total + value, 0);
    const isMaster = raw.includes("#EXT-X-STREAM-INF");
    if (
      !isMaster &&
      (!raw.includes("#EXT-X-MAP:") ||
        !raw.includes("#EXT-X-PLAYLIST-TYPE:VOD") ||
        !raw.includes("#EXT-X-ENDLIST"))
    ) {
      throw new Error(
        `CMAF VOD playlist is missing init/VOD/end markers: ${playlist}`,
      );
    }
  }
  // Access masters deliberately have no EXTINF entries: they reference
  // already-qualified media playlists and are not themselves media tracks.
  const mediaPlaylists = playlists.filter(
    (file) => !["master.m3u8", "standard.m3u8", "high.m3u8"].includes(file),
  );
  if (mediaPlaylists.length < 3)
    throw new Error(
      "adaptive HLS requires shared audio and at least two video playlists",
    );
  const master = await readFile(join(outputDir, "master.m3u8"), "utf8");
  const variantCount = (master.match(/#EXT-X-STREAM-INF/g) ?? []).length;
  if (
    variantCount < 2 ||
    !master.includes('AUDIO="audio"') ||
    !master.includes("CODECS=") ||
    !master.includes("RESOLUTION=")
  )
    throw new Error("adaptive HLS master has no valid audio group or ladder");
  if (!master.includes("#EXT-X-INDEPENDENT-SEGMENTS"))
    throw new Error(
      "adaptive HLS master does not declare independently decodable segments",
    );
  const durations = Object.values(timeline);
  if (
    durations.length > 1 &&
    Math.max(...durations) - Math.min(...durations) > 6.25
  )
    throw new Error("HLS audio/video timelines drift beyond one segment");
  const masterProbe = await getMediaInfo(join(outputDir, "master.m3u8")).catch(
    () => undefined,
  );
  if (
    masterProbe &&
    masterProbe.duration > 0 &&
    durations.length &&
    Math.abs(masterProbe.duration - Math.max(...durations)) > 6.25
  )
    throw new Error("HLS probe duration differs from manifest timeline");
  const declaredBandwidth = [...master.matchAll(/BANDWIDTH=(\d+)/g)].map(
    (match) => Number(match[1]),
  );
  const measuredBandwidth: Record<string, number> = {};
  for (const playlist of mediaPlaylists) {
    const raw = await readFile(join(outputDir, playlist), "utf8");
    const refs = raw
      .split("\n")
      .map((v) => v.trim())
      .filter((v) => v && !v.startsWith("#") && v.endsWith(".m4s"));
    const bytes = (
      await Promise.all(
        refs.map((ref) =>
          stat(join(outputDir, ref)).then((entry) => entry.size),
        ),
      )
    ).reduce((sum, value) => sum + value, 0);
    const bandwidth = timeline[playlist]
      ? Math.ceil((bytes * 8) / timeline[playlist]!)
      : 0;
    if (bandwidth <= 0)
      throw new Error(`HLS playlist ${playlist} has no measurable bandwidth`);
    measuredBandwidth[playlist] = bandwidth;
    if (playlist !== "audio.m3u8") {
      let packetJson = "";
      const packetProbe = await runManagedProcess({
        label: "ffprobe",
        args: [
          "-v",
          "error",
          "-read_intervals",
          "%+1",
          "-select_streams",
          "v:0",
          "-show_packets",
          "-of",
          "json",
          join(outputDir, playlist),
        ],
        timeoutMs: 60_000,
        noProgressTimeoutMs: MEDIA_COMMAND_NO_PROGRESS_TIMEOUT_MS,
        onStdout: (chunk) => {
          packetJson += chunk.toString();
        },
      });
      if (packetProbe.code !== 0)
        throw new Error(`cannot inspect HLS keyframes for ${playlist}`);
      const packets =
        (
          JSON.parse(packetJson) as {
            packets?: Array<{ flags?: string; pts_time?: string }>;
          }
        ).packets ?? [];
      if (!packets.length || !packets[0]?.flags?.includes("K"))
        throw new Error(
          `HLS playlist does not start on a keyframe: ${playlist}`,
        );
      keyframes[playlist] = {
        first_packet_keyframe: true,
        first_pts: packets[0]?.pts_time,
      };
    }
    const segmentDurations = [
      ...raw.matchAll(/#EXTINF:([0-9.]+)[^\n]*\n([^\n]+)/g),
    ].map((match) => ({ duration: Number(match[1]), ref: match[2]?.trim() }));
    for (const index of [
      ...new Set([
        0,
        Math.floor(segmentDurations.length / 2),
        segmentDurations.length - 1,
      ]),
    ]) {
      const segment = segmentDurations[index];
      if (!segment?.ref || !Number.isFinite(segment.duration))
        throw new Error(`HLS playlist cannot map segment timing: ${playlist}`);
      const offset = segmentDurations
        .slice(0, index)
        .reduce((total, value) => total + value.duration, 0);
      let segmentStderr = "";
      const segmentProbe = await runManagedProcess({
        label: "ffmpeg",
        args: [
          "-v",
          "error",
          "-ss",
          offset.toFixed(3),
          "-i",
          join(outputDir, playlist),
          "-t",
          Math.min(segment.duration, 1).toFixed(3),
          "-f",
          "null",
          "-",
        ],
        timeoutMs: 60_000,
        noProgressTimeoutMs: MEDIA_COMMAND_NO_PROGRESS_TIMEOUT_MS,
        onStderr: (chunk) => {
          segmentStderr += chunk.toString();
        },
      });
      if (segmentProbe.code !== 0)
        throw new Error(
          `HLS segment playback probe failed for ${playlist}:${segment.ref}: ${segmentStderr.slice(-512)}`,
        );
      probes[`${playlist}:${segment.ref}`] = {
        offset,
        duration: segment.duration,
        playback_probe: true,
      };
    }
  }
  if (declaredBandwidth.some((value) => value <= 0))
    throw new Error("HLS master has an invalid bandwidth declaration");
  const playbackDuration = Math.max(...Object.values(timeline));
  const seeks = [
    Math.min(1, playbackDuration / 4),
    playbackDuration / 2,
    Math.max(0, playbackDuration - 1),
  ];
  const seekEvidence: Array<{ seconds: number; ok: boolean }> = [];
  for (const seek of seeks) {
    let seekStderr = "";
    const seekResult = await runManagedProcess({
      label: "ffmpeg",
      args: [
        "-v",
        "error",
        "-ss",
        seek.toFixed(3),
        "-i",
        join(outputDir, "master.m3u8"),
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      ],
      timeoutMs: 60_000,
      noProgressTimeoutMs: MEDIA_COMMAND_NO_PROGRESS_TIMEOUT_MS,
      onStderr: (chunk) => {
        seekStderr += chunk.toString();
      },
    });
    if (seekResult.code !== 0)
      throw new Error(
        `HLS seek validation failed at ${seek}s: ${seekStderr.slice(-512)}`,
      );
    seekEvidence.push({ seconds: seek, ok: true });
  }
  return {
    files,
    playlistCount: playlists.length,
    evidence: {
      segment_format: "cmaf-fmp4",
      variant_count: variantCount,
      audio_group: "audio",
      playlists: mediaPlaylists,
      timeline_seconds: timeline,
      master_probe_duration: masterProbe?.duration,
      measured_bandwidth: measuredBandwidth,
      segment_probes: probes,
      keyframe_alignment: keyframes,
      seeks: seekEvidence,
      ownership: "relative-local-package-only",
      cache_contract: { playlists: "no-cache", segments: "immutable" },
    },
  };
}

export const transcoder = {
  getMediaInfo,
  transcodeToMp4,
  transcodeAudioToM4a,
  transcodeAudioLadderToM4a,
  planAudioDeliveryLadder,
  resolveAudioBitrateKbps,
  extractThumbnail,
  extractAudio,
  cutMediaSegment,
  createAdaptiveHlsPackage,
  createHlsAccessMaster,
  validateAdaptiveHlsPackage,
};
