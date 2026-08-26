/**
 * Media module exports
 */
export {
  downloader,
  downloadYouTube,
  downloadYouTubeAudio,
  downloadHttp,
  cleanupTempFile,
  type DownloadResult,
} from "./downloader.js";

export {
  transcoder,
  getMediaInfo,
  transcodeToMp4,
  transcodeAudioToM4a,
  transcodeAudioLadderToM4a,
  planAudioDeliveryLadder,
  resolveAudioBitrateKbps,
  remuxToMp4,
  transcodeProgressive,
  createAdaptiveHlsPackage,
  validateAdaptiveHlsPackage,
  extractThumbnail,
  extractAudio,
  type MediaInfo,
  type TranscodeResult,
  type AudioQualityTier,
  type AudioLadderPlan,
  type AudioLadderOutput,
} from "./transcoder.js";

export {
  createAndUploadAudioDeliveryLadder,
  preferredAudioRendition,
  type UploadedAudioLadderRendition,
} from "./audio-ladder.js";

export {
  planDeliveryRoute,
  type DeliveryRoute,
  type RouteDecision,
  type RoutePolicy,
} from "./route-planner.js";
