export type PodsResetTier = "primary" | "cold";
export const MAX_PODS_RESET_OBJECTS = 1000;
// R2's S3 API addresses deletion by the current object key; it does not carry
// the per-upload R2 version UUID as a delete precondition. DB write fencing is
// therefore mandatory before the exact current key may be deleted.
export const PODS_RESET_VERSION_MODEL = "cloudflare-r2-current-key-delete-v1";

export function requireSupportedPodsResetVersionModel(
  endpoints: string[],
): string {
  if (endpoints.length === 0)
    throw new Error(
      "Pods reset cannot identify the storage provider version model",
    );
  for (const endpoint of endpoints) {
    let host: string;
    try {
      host = new URL(endpoint).hostname.toLowerCase();
    } catch {
      throw new Error(
        "Pods reset cannot identify the storage provider version model",
      );
    }
    if (!host.endsWith(".r2.cloudflarestorage.com"))
      throw new Error(
        "Pods reset is not qualified for this provider's current-key delete semantics",
      );
  }
  return PODS_RESET_VERSION_MODEL;
}

export interface PodsResetObjectIdentity {
  storage_tier: PodsResetTier;
  bucket: string;
  object_key: string;
  etag: string;
  size_bytes: number;
}

export interface PodsResetStorageBinding {
  storage_tier: PodsResetTier;
  bucket: string;
  endpoint_fingerprint: string;
}

export function validatePodsResetStorageBindings(
  tiers: string[],
  bindings: PodsResetStorageBinding[],
): boolean {
  const wanted = new Set(tiers);
  if (
    wanted.size === 0 ||
    wanted.size !== tiers.length ||
    bindings.length !== wanted.size ||
    [...wanted].some((tier) => tier !== "primary" && tier !== "cold")
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (
      !wanted.has(binding.storage_tier) ||
      seen.has(binding.storage_tier) ||
      !binding.bucket.trim() ||
      !/^[a-f0-9]{64}$/i.test(binding.endpoint_fingerprint)
    ) {
      return false;
    }
    seen.add(binding.storage_tier);
  }
  return seen.size === wanted.size;
}

export function samePodsResetStorageBindings(
  left: PodsResetStorageBinding[],
  right: PodsResetStorageBinding[],
): boolean {
  const key = (binding: PodsResetStorageBinding) =>
    `${binding.storage_tier}\n${binding.bucket}\n${binding.endpoint_fingerprint.toLowerCase()}`;
  const leftKeys = left.map(key).sort();
  const rightKeys = right.map(key).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((value, index) => value === rightKeys[index])
  );
}

export interface PodsResetInventoryRow {
  content_item_id: string;
  storage_tier: PodsResetTier;
  bucket: string;
  object_key: string;
  etag: string;
  size_bytes: number;
}

export interface PodsResetInventoryDiff {
  deletable: PodsResetInventoryRow[];
  missing: PodsResetObjectIdentity[];
  changed: Array<{
    expected: PodsResetObjectIdentity;
    actual: PodsResetInventoryRow;
  }>;
  unlisted: PodsResetInventoryRow[];
}

/** Wire shape consumed by the CMS reset saga; keep the mixed legacy key casing explicit. */
export function podsResetDeleteResponse(
  contentItemId: string,
  fencingToken: string,
  result: {
    storageBindings: PodsResetStorageBinding[];
    objectsAbsent: boolean;
    deletedCount: number;
    freedBytes: number;
    deletedObjects: PodsResetObjectIdentity[];
    alreadyAbsentObjects: PodsResetObjectIdentity[];
  },
) {
  return {
    data: {
      content_item_id: contentItemId,
      storage_bindings: result.storageBindings,
      objectsAbsent: result.objectsAbsent,
      deletedCount: result.deletedCount,
      freedBytes: result.freedBytes,
      deletedObjects: result.deletedObjects,
      alreadyAbsentObjects: result.alreadyAbsentObjects,
      fencing_token: fencingToken,
    },
  };
}

function objectIdentityKey(value: PodsResetObjectIdentity): string {
  return [value.storage_tier, value.bucket, value.object_key].join("\n");
}

/**
 * Compare a frozen manifest to a complete current inventory. A previously
 * deleted frozen object is allowed for an idempotent retry; changed or new
 * identities are never deleted under the old approval.
 */
export function comparePodsResetInventory(
  expected: PodsResetObjectIdentity[],
  actual: PodsResetInventoryRow[],
): PodsResetInventoryDiff {
  const expectedByKey = new Map(
    expected.map((entry) => [objectIdentityKey(entry), entry]),
  );
  const actualByKey = new Map(
    actual.map((entry) => [objectIdentityKey(entry), entry]),
  );
  const missing: PodsResetObjectIdentity[] = [];
  const changed: PodsResetInventoryDiff["changed"] = [];
  const deletable: PodsResetInventoryRow[] = [];
  for (const [key, wanted] of expectedByKey) {
    const found = actualByKey.get(key);
    if (!found) {
      missing.push(wanted);
      continue;
    }
    if (found.etag !== wanted.etag || found.size_bytes !== wanted.size_bytes) {
      changed.push({ expected: wanted, actual: found });
      continue;
    }
    deletable.push(found);
  }
  const unlisted = actual.filter(
    (entry) => !expectedByKey.has(objectIdentityKey(entry)),
  );
  return { deletable, missing, changed, unlisted };
}
