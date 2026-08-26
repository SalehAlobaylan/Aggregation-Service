import { describe, expect, it } from "vitest";
import { planDeliveryRoute } from "../../../src/media/route-planner.js";

const videoProbe = {
  duration: 900,
  format: "mov,mp4,m4a,3gp,3g2,mj2",
  normalizedMime: "video/mp4",
  hasAudio: true,
  visualAvailable: true,
  videoCodec: "h264",
  audioCodec: "aac",
  pixelFormat: "yuv420p",
  frameRate: 30,
  seekable: true,
  width: 1280,
  height: 720,
};
const hlsPolicy = {
  policy_digest: "a".repeat(64),
  allow_passthrough: true,
  allow_remux: true,
  allow_hls: true,
  rollout_state: "active" as const,
  hls_min_variants: 2,
  max_delivery_height: 720,
};

describe("planDeliveryRoute", () => {
  it("is deterministic and makes long parents source-only before delivery work", () => {
    const input = {
      probe: { ...videoProbe, duration: 14_401 },
      policy: hlsPolicy,
      suitability: "visual_dependent",
      durationSec: 14_401,
      trustedLongForm: true,
    };
    const first = planDeliveryRoute(input);
    expect(first).toEqual(planDeliveryRoute(input));
    expect(first.route).toBe("source_only_long_form");
    expect(first.expected).toMatchObject({
      source: true,
      progressive: false,
      hls: false,
    });
  });

  it("uses CMAF only with at least two source-bounded variants", () => {
    expect(
      planDeliveryRoute({
        probe: videoProbe,
        policy: hlsPolicy,
        suitability: "visual_dependent",
        durationSec: 900,
        trustedLongForm: false,
      }).route,
    ).toBe("adaptive_hls_transcode");
    expect(
      planDeliveryRoute({
        probe: { ...videoProbe, height: 400 },
        policy: hlsPolicy,
        suitability: "visual_dependent",
        durationSec: 900,
        trustedLongForm: false,
      }).route,
    ).toBe("progressive_passthrough");
  });

  it("does not make an audio file into video", () => {
    const decision = planDeliveryRoute({
      probe: {
        duration: 600,
        format: "mp3",
        normalizedMime: "audio/mpeg",
        hasAudio: true,
        visualAvailable: false,
        audioCodec: "mp3",
      },
      policy: { policy_digest: "b".repeat(64), allow_passthrough: true },
      suitability: "audio_first_show",
      durationSec: 600,
      trustedLongForm: false,
    });
    expect(decision.route).toBe("audio_passthrough");
    expect(decision.expected).toMatchObject({
      audio: true,
      progressive: false,
      hls: false,
    });
    expect(
      planDeliveryRoute({
        probe: {
          duration: 600,
          format: "mp3",
          hasAudio: true,
          visualAvailable: false,
          audioCodec: "mp3",
        },
        policy: {
          policy_digest: "b".repeat(64),
          allow_passthrough: true,
        },
        suitability: "audio_first_show",
        durationSec: 600,
        trustedLongForm: false,
      }).route,
    ).toBe("audio_transcode");
  });

  it("defers capacity rather than falsely rejecting valid media", () => {
    expect(
      planDeliveryRoute({
        probe: videoProbe,
        policy: hlsPolicy,
        suitability: "visual_dependent",
        durationSec: 900,
        trustedLongForm: false,
        capacityAvailable: false,
      }).route,
    ).toBe("deferred_capacity");
  });
});
