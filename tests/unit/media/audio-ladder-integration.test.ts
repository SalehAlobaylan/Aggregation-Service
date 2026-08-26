import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("native audio ladder integration", () => {
  it.each([
    ["fresh ingest", "../../../src/workers/media.worker.ts"],
    [
      "generation-safe repair",
      "../../../src/workers/pipeline-repair-stage-executor.ts",
    ],
    ["durable atomization", "../../../src/workers/atomization.worker.ts"],
  ])("uses the canonical decode-once producer for %s", (_label, file) => {
    const code = source(file);
    expect(code).toContain("createAndUploadAudioDeliveryLadder");
    expect(code).not.toContain("cutAudioSegment(");
  });

  it("contains no retired audio-to-static-video or single-tier chapter API", () => {
    const transcoder = source("../../../src/media/transcoder.ts");
    expect(transcoder).not.toContain("audioToMp4");
    expect(transcoder).not.toContain("export function cutAudioSegment");
  });
});
