import { describe, expect, it } from "vitest";
import {
  comparePodsResetInventory,
  requireSupportedPodsResetVersionModel,
  samePodsResetStorageBindings,
  validatePodsResetStorageBindings,
  PODS_RESET_VERSION_MODEL,
  type PodsResetObjectIdentity,
  type PodsResetInventoryRow,
  type PodsResetStorageBinding,
} from "../../src/storage/pods-reset.js";

const frozen: PodsResetObjectIdentity[] = [
  {
    storage_tier: "primary",
    bucket: "hot",
    object_key: "content/abc/original.mp4",
    etag: "one",
    size_bytes: 100,
  },
  {
    storage_tier: "cold",
    bucket: "cold",
    object_key: "content/abc/hls/seg-1.m4s",
    etag: "two",
    size_bytes: 25,
  },
];
const bindings: PodsResetStorageBinding[] = [
  { storage_tier: "primary", bucket: "hot", endpoint_fingerprint: "a".repeat(64) },
  { storage_tier: "cold", bucket: "cold", endpoint_fingerprint: "b".repeat(64) },
];

function row(value: PodsResetObjectIdentity): PodsResetInventoryRow {
  return { content_item_id: "abc", ...value };
}

describe("Pods reset exact inventory comparison", () => {
  it("accepts an unchanged complete hot and cold inventory", () => {
    const diff = comparePodsResetInventory(frozen, frozen.map(row));
    expect(diff.deletable).toHaveLength(2);
    expect(diff.missing).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unlisted).toEqual([]);
  });

  it("treats previously absent approved objects as safe idempotent retry progress", () => {
    const diff = comparePodsResetInventory(frozen, [row(frozen[1])]);
    expect(diff.deletable).toEqual([row(frozen[1])]);
    expect(diff.missing).toEqual([frozen[0]]);
    expect(diff.changed).toEqual([]);
  });

  it("blocks a changed fingerprint instead of deleting the replacement", () => {
    const replacement = row({ ...frozen[0], etag: "changed", size_bytes: 101 });
    const diff = comparePodsResetInventory(frozen, [
      replacement,
      row(frozen[1]),
    ]);
    expect(diff.changed).toEqual([
      { expected: frozen[0], actual: replacement },
    ]);
    expect(diff.deletable).toEqual([row(frozen[1])]);
  });

  it("blocks newly discovered keys and distinguishes their storage tier", () => {
    const extra = row({
      storage_tier: "primary",
      bucket: "hot",
      object_key: "content/abc/new-upload.mp4",
      etag: "new",
      size_bytes: 1,
    });
    const diff = comparePodsResetInventory(frozen, [...frozen.map(row), extra]);
    expect(diff.unlisted).toEqual([extra]);
    expect(diff.deletable).toHaveLength(2);
  });
});

describe("Pods reset storage delete model", () => {
  it("accepts only explicitly supported Cloudflare R2 endpoints", () => {
    expect(
      requireSupportedPodsResetVersionModel([
        "https://account.r2.cloudflarestorage.com",
        "https://another-account.r2.cloudflarestorage.com",
      ]),
    ).toBe(PODS_RESET_VERSION_MODEL);
    expect(() =>
      requireSupportedPodsResetVersionModel(["http://minio:9000"]),
    ).toThrow(/not qualified/);
    expect(() => requireSupportedPodsResetVersionModel(["not-a-url"])).toThrow(
      /cannot identify/,
    );
    expect(() => requireSupportedPodsResetVersionModel([])).toThrow(
      /cannot identify/,
    );
  });

  it("freezes every configured provider and bucket binding, including empty tiers", () => {
    expect(validatePodsResetStorageBindings(["primary", "cold"], bindings)).toBe(true);
    expect(validatePodsResetStorageBindings(["primary", "cold"], bindings.slice(0, 1))).toBe(false);
    expect(validatePodsResetStorageBindings(["primary"], bindings)).toBe(false);

    const changedAccount = bindings.map((binding) => ({ ...binding }));
    changedAccount[0].endpoint_fingerprint = "c".repeat(64);
    expect(samePodsResetStorageBindings(bindings, changedAccount)).toBe(false);
    expect(samePodsResetStorageBindings(bindings, [...bindings].reverse())).toBe(true);
  });
});
