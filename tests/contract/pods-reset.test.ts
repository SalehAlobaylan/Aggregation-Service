import { describe, expect, it } from "vitest";
import { podsResetDeleteResponse } from "../../src/storage/pods-reset.js";

describe("Pods reset CMS deletion response contract", () => {
  it("serializes exact object outcomes with the CMS wire field names", () => {
    const deleted = {
      storage_tier: "primary" as const,
      bucket: "media",
      object_key: "content/00000000-0000-4000-8000-000000000001/original.mp4",
      etag: "abc123",
      size_bytes: 123,
    };
    const alreadyAbsent = {
      storage_tier: "cold" as const,
      bucket: "archive",
      object_key: "content/00000000-0000-4000-8000-000000000001/hls/segment.m4s",
      etag: "def456",
      size_bytes: 45,
    };
    const storageBindings = [
      { storage_tier: "primary" as const, bucket: "media", endpoint_fingerprint: "a".repeat(64) },
      { storage_tier: "cold" as const, bucket: "archive", endpoint_fingerprint: "b".repeat(64) },
    ];

    expect(
      podsResetDeleteResponse(
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        {
          storageBindings,
          objectsAbsent: true,
          deletedCount: 1,
          freedBytes: 123,
          deletedObjects: [deleted],
          alreadyAbsentObjects: [alreadyAbsent],
        },
      ),
    ).toEqual({
      data: {
        content_item_id: "00000000-0000-4000-8000-000000000001",
        storage_bindings: storageBindings,
        objectsAbsent: true,
        deletedCount: 1,
        freedBytes: 123,
        deletedObjects: [deleted],
        alreadyAbsentObjects: [alreadyAbsent],
        fencing_token: "00000000-0000-4000-8000-000000000002",
      },
    });
  });
});
