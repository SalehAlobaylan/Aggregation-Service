import { createHash } from "node:crypto";

export type DeliveryRoute =
  | "audio_passthrough"
  | "audio_transcode"
  | "progressive_passthrough"
  | "progressive_remux"
  | "progressive_transcode"
  | "adaptive_hls_transcode"
  | "source_only_long_form"
  | "terminal_invalid_media"
  | "deferred_capacity";

export interface RouteProbe {
  duration: number;
  format: string;
  normalizedMime?: string;
  hasAudio: boolean;
  visualAvailable: boolean;
  videoCodec?: string;
  videoProfile?: string;
  videoLevel?: string;
  pixelFormat?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  bitrateKbps?: number;
  audioBitrateKbps?: number;
  audioChannels?: number;
  audioSampleRate?: number;
  startTime?: number;
  seekable?: boolean;
  rotation?: number;
  displayAspectRatio?: string;
  colorSpace?: string;
  probeDigest?: string;
}
export interface RoutePolicy {
  id?: string;
  policy_digest?: string;
  schema_version?: number;
  primary_mode?: "audio" | "progressive" | "hls";
  allow_passthrough?: boolean;
  allow_remux?: boolean;
  allow_hls?: boolean;
  require_adaptive_hls?: boolean;
  generate_audio_alternate?: boolean;
  generate_progressive_fallback?: boolean;
  max_delivery_height?: number;
  hls_min_variants?: number;
  rollout_state?: "shadow" | "active" | "disabled";
  variants?: Array<{
    rendition_type: string;
    quality_tier: string;
    priority: number;
    required: boolean;
    enabled: boolean;
  }>;
}
export interface RenditionSpec {
  role:
    | "source"
    | "audio_primary"
    | "audio_alternate"
    | "progressive_primary"
    | "progressive_fallback"
    | "hls_master";
  type: "source" | "audio" | "mp4" | "hls";
  required: boolean;
  maxHeight?: number;
}
export interface RouteDecision {
  route: DeliveryRoute;
  digest: string;
  reasons: string[];
  expected: {
    source: boolean;
    audio: boolean;
    progressive: boolean;
    hls: boolean;
  };
  renditions: RenditionSpec[];
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
export function snapshotDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function legalAudio(p: RouteProbe): boolean {
  const codec = (p.audioCodec ?? "").toLowerCase();
  const containerIsCompatible =
    (codec === "aac" &&
      p.normalizedMime === "audio/mp4" &&
      (p.format.includes("mp4") || p.format.includes("mov"))) ||
    (codec === "mp3" &&
      p.normalizedMime === "audio/mpeg" &&
      p.format.includes("mp3"));
  return (
    containerIsCompatible &&
    p.duration > 0 &&
    p.seekable !== false &&
    (p.audioChannels ?? 2) <= 2 &&
    (p.audioSampleRate ?? 48000) <= 48000
  );
}
function legalProgressive(p: RouteProbe, policy: RoutePolicy): boolean {
  return (
    p.format.includes("mp4") &&
    p.normalizedMime === "video/mp4" &&
    p.videoCodec === "h264" &&
    p.audioCodec === "aac" &&
    (p.height ?? 0) <= (policy.max_delivery_height ?? 720) &&
    (p.frameRate ?? 30) <= 30 &&
    p.pixelFormat === "yuv420p" &&
    p.seekable !== false &&
    p.duration > 0
  );
}
function remuxableProgressive(p: RouteProbe, policy: RoutePolicy): boolean {
  return (
    p.videoCodec === "h264" &&
    p.audioCodec === "aac" &&
    (p.height ?? 0) <= (policy.max_delivery_height ?? 720) &&
    (p.frameRate ?? 30) <= 30 &&
    p.seekable !== false &&
    p.duration > 0
  );
}
function hlsVariantCount(p: RouteProbe): number {
  return [360, 540, 720].filter((candidate) => candidate <= (p.height ?? 0))
    .length;
}
function specs(
  route: DeliveryRoute,
  probe: RouteProbe,
  policy: RoutePolicy,
): RenditionSpec[] {
  const audio: RenditionSpec = {
    role: "audio_primary",
    type: "audio",
    required: true,
  };
  if (route === "source_only_long_form")
    return [{ role: "source", type: "source", required: true }];
  if (route === "audio_passthrough" || route === "audio_transcode")
    return [audio];
  if (route === "adaptive_hls_transcode")
    return [
      audio,
      { role: "hls_master", type: "hls", required: true },
      {
        role: "progressive_fallback",
        type: "mp4",
        required: true,
        maxHeight: Math.min(720, probe.height ?? 720),
      },
    ];
  const visualMax =
    policy.primary_mode === "audio"
      ? 480
      : Math.min(policy.max_delivery_height ?? 720, probe.height ?? 720);
  const primary: RenditionSpec = {
    role: "progressive_primary",
    type: "mp4",
    required: true,
    maxHeight: visualMax,
  };
  return policy.generate_audio_alternate === false
    ? [primary]
    : [audio, primary];
}

/** Pure route selection. Its returned snapshot is persisted before delivery work begins. */
export function planDeliveryRoute(input: {
  probe: RouteProbe;
  policy: RoutePolicy;
  suitability: string;
  durationSec: number;
  trustedLongForm: boolean;
  capacityAvailable?: boolean;
}): RouteDecision {
  const reasons: string[] = [];
  const p = input.probe;
  let route: DeliveryRoute;
  if (input.capacityAvailable === false) route = "deferred_capacity";
  else if (!p.hasAudio || p.duration <= 0 || p.seekable === false) {
    route = "terminal_invalid_media";
    reasons.push("missing_audio_duration_or_seeking");
  } else if (input.trustedLongForm && input.durationSec > 2400)
    route = "source_only_long_form";
  else if (!p.visualAvailable) {
    route =
      input.policy.allow_passthrough !== false && legalAudio(p)
        ? "audio_passthrough"
        : "audio_transcode";
    if (route === "audio_transcode") reasons.push("native_audio_gate_rejected");
  } else if (
    input.suitability === "visual_dependent" &&
    input.policy.allow_hls !== false &&
    input.policy.rollout_state === "active" &&
    hlsVariantCount(p) >= (input.policy.hls_min_variants ?? 2)
  )
    route = "adaptive_hls_transcode";
  else if (
    input.policy.allow_passthrough !== false &&
    legalProgressive(p, input.policy)
  )
    route = "progressive_passthrough";
  else if (
    input.policy.allow_remux !== false &&
    remuxableProgressive(p, input.policy)
  )
    route = "progressive_remux";
  else route = "progressive_transcode";
  if (
    input.suitability === "visual_dependent" &&
    route !== "adaptive_hls_transcode"
  )
    reasons.push("adaptive_hls_not_legal_for_source");
  const expected = {
    source: route === "source_only_long_form",
    audio:
      route.startsWith("audio_") ||
      route === "source_only_long_form" ||
      route === "adaptive_hls_transcode" ||
      (p.visualAvailable &&
        route.startsWith("progressive_") &&
        input.policy.generate_audio_alternate !== false),
    progressive:
      route.startsWith("progressive_") || route === "adaptive_hls_transcode",
    hls: route === "adaptive_hls_transcode",
  };
  const renditions = specs(route, p, input.policy);
  const stable = {
    route,
    reasons,
    expected,
    renditions,
    probe: p,
    policy: input.policy,
    suitability: input.suitability,
    durationSec: input.durationSec,
  };
  return {
    route,
    reasons,
    expected,
    renditions,
    digest: snapshotDigest(stable),
  };
}
