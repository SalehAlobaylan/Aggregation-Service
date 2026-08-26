import { describe, expect, it } from "vitest";
import { planAudioDeliveryLadder } from "../../../src/media/transcoder.js";

describe("planAudioDeliveryLadder", () => {
  it("produces the three strict ceilings for a high-bitrate source", () => {
    expect(planAudioDeliveryLadder(256, false)).toEqual({
      sourceBitrateKbps: 256,
      encode: [
        { tier: "data_saver", targetBitrateKbps: 64, maxBitrateKbps: 64 },
        { tier: "standard", targetBitrateKbps: 128, maxBitrateKbps: 128 },
        { tier: "high", targetBitrateKbps: 192, maxBitrateKbps: 192 },
      ],
    });
  });

  it("never up-bitrates a source between tier ceilings", () => {
    expect(planAudioDeliveryLadder(96, false).encode).toEqual([
      { tier: "data_saver", targetBitrateKbps: 64, maxBitrateKbps: 64 },
      { tier: "standard", targetBitrateKbps: 96, maxBitrateKbps: 128 },
    ]);
    expect(planAudioDeliveryLadder(160, false).encode).toEqual([
      { tier: "data_saver", targetBitrateKbps: 64, maxBitrateKbps: 64 },
      { tier: "standard", targetBitrateKbps: 128, maxBitrateKbps: 128 },
      { tier: "high", targetBitrateKbps: 160, maxBitrateKbps: 192 },
    ]);
  });

  it("reuses a compatible source at its natural tier and encodes only lowers", () => {
    expect(planAudioDeliveryLadder(96, true)).toEqual({
      sourceTier: "standard",
      sourceBitrateKbps: 96,
      encode: [
        { tier: "data_saver", targetBitrateKbps: 64, maxBitrateKbps: 64 },
      ],
    });
    expect(planAudioDeliveryLadder(48, true)).toEqual({
      sourceTier: "data_saver",
      sourceBitrateKbps: 48,
      encode: [],
    });
  });

  it("fails closed instead of up-bitrating an unmeasured source", () => {
    expect(planAudioDeliveryLadder(undefined, true)).toEqual({ encode: [] });
  });
});
