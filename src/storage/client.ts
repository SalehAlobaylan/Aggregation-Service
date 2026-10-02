/**
 * S3-Compatible Storage Client
 * Supports MinIO (dev) and Supabase Storage (prod)
 */
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type PutObjectCommandInput,
  type _Object as S3Object,
  type ObjectIdentifier,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { createHash } from "node:crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { lookup } from "mime-types";
import { config } from "../config/index.js";
import { logger } from "../observability/logger.js";
import { attachOpCounter } from "./op-counter.js";
import {
  comparePodsResetInventory,
  MAX_PODS_RESET_OBJECTS,
  requireSupportedPodsResetVersionModel,
  type PodsResetInventoryRow,
  type PodsResetObjectIdentity,
  type PodsResetStorageBinding,
  type PodsResetTier,
  samePodsResetStorageBindings,
  validatePodsResetStorageBindings,
} from "./pods-reset.js";

// -----------------------------------------------------------------------------
// Two-tier storage: primary (hot) is the bucket every upload lands in. cold is
// an optional secondary bucket the storage worker can move purge candidates to
// instead of deleting them outright. Both are S3-compatible — provider doesn't
// matter (R2, AWS S3, Supabase, MinIO, B2, Wasabi, …).
// -----------------------------------------------------------------------------

export type StorageTier = "primary" | "cold";

const primaryClient = new S3Client({
  endpoint: config.storageEndpoint,
  region: config.storageRegion,
  credentials: {
    accessKeyId: config.storageAccessKey,
    secretAccessKey: config.storageSecretKey,
  },
  forcePathStyle: true,
});

const coldClient =
  config.coldStorageEnabled && config.coldStorageEndpoint
    ? new S3Client({
        endpoint: config.coldStorageEndpoint,
        region: config.coldStorageRegion,
        credentials: {
          accessKeyId: config.coldStorageAccessKey ?? "",
          secretAccessKey: config.coldStorageSecretKey ?? "",
        },
        forcePathStyle: true,
      })
    : null;

// Attach the op counter to every constructed S3 client so we can track
// Class A / Class B operation counts against the free-tier budget. Adds one
// in-memory increment per `client.send(...)`; no call-site changes needed.
attachOpCounter(primaryClient, "primary");
if (coldClient) attachOpCounter(coldClient, "cold");

// Backwards-compat alias for existing callers that imported s3Client directly.
const s3Client = primaryClient;

/**
 * A streamed PutObject can leave a reused TLS socket in a bad-record state
 * after a R2 edge reset.  The shared client is still ideal for ordinary HEAD
 * and LIST traffic, but upload retries must use a fresh transport and a fresh
 * socket pool.  This keeps a transient connection failure from poisoning all
 * subsequent renditions in the same atomization attempt.
 */
function createUploadClient(tier: StorageTier): S3Client {
  const endpoint =
    tier === "cold" ? config.coldStorageEndpoint : config.storageEndpoint;
  const region =
    tier === "cold" ? config.coldStorageRegion : config.storageRegion;
  const accessKeyId =
    tier === "cold" ? config.coldStorageAccessKey : config.storageAccessKey;
  const secretAccessKey =
    tier === "cold" ? config.coldStorageSecretKey : config.storageSecretKey;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(`${tier} storage tier is not configured`);
  }
  const client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({
      // Do not reuse a socket after a streaming TLS reset.  Each retry owns
      // this handler and is destroyed immediately after the request settles.
      httpAgent: new HttpAgent({ keepAlive: false, maxSockets: 8 }),
      httpsAgent: new HttpsAgent({ keepAlive: false, maxSockets: 8 }),
      requestTimeout: 0,
    }),
  });
  attachOpCounter(client, tier);
  return client;
}

export function isColdTierConfigured(): boolean {
  return Boolean(
    config.coldStorageEnabled &&
    config.coldStorageEndpoint &&
    config.coldStorageBucket &&
    config.coldStorageAccessKey &&
    config.coldStorageSecretKey,
  );
}

interface TierBinding {
  client: S3Client;
  bucket: string;
  publicUrl: string;
}

function bindingFor(tier: StorageTier): TierBinding {
  if (tier === "cold") {
    if (
      !coldClient ||
      !config.coldStorageBucket ||
      !config.coldStoragePublicUrl
    ) {
      throw new Error("Cold storage tier is not configured");
    }
    return {
      client: coldClient,
      bucket: config.coldStorageBucket,
      publicUrl: config.coldStoragePublicUrl,
    };
  }
  return {
    client: primaryClient,
    bucket: config.storageBucket,
    publicUrl: config.storagePublicUrl,
  };
}

/**
 * Generate deterministic storage key for content artifacts.
 * The key path is identical across tiers — only the bucket changes.
 */
export function getStorageKey(
  contentItemId: string,
  artifactType: "original" | "processed" | "thumbnail" | "audio" | "hls",
  extension: string,
): string {
  return `content/${contentItemId}/${artifactType}.${extension}`;
}

/**
 * Generate an immutable attempt-owned key for newly produced artifacts.
 * Legacy stable keys remain readable for repair/backfill, but new writes must
 * not overwrite an artifact produced by a different attempt.
 */
export function getAttemptStorageKey(
  contentItemId: string,
  attemptId: string,
  artifactType: "source" | "processed" | "thumbnail" | "analysis-audio",
  extension: string,
): string {
  const safeAttempt = attemptId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `content/${contentItemId}/attempts/${safeAttempt}/${artifactType}.${extension}`;
}

/**
 * Get public URL for a storage key. Defaults to the primary tier so existing
 * callers don't need to change.
 */
export function getPublicUrl(
  key: string,
  tier: StorageTier = "primary",
): string {
  const { publicUrl } = bindingFor(tier);
  return `${publicUrl.replace(/\/$/, "")}/${key}`;
}

function isMissingObjectError(error: unknown): boolean {
  const err = error as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    err?.$metadata?.httpStatusCode === 404 ||
    err?.name === "NotFound" ||
    err?.name === "NoSuchKey" ||
    err?.code === "NotFound" ||
    err?.code === "NoSuchKey"
  );
}

/**
 * Check if an object exists in storage
 */
export async function objectExists(
  key: string,
  tier: StorageTier = "primary",
  signal?: AbortSignal,
): Promise<boolean> {
  const { client, bucket } = bindingFor(tier);
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
      { abortSignal: signal },
    );
    return true;
  } catch (error) {
    if (isMissingObjectError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * HEAD an object and return its size, or 0 if missing.
 */
export async function getObjectSize(
  key: string,
  tier: StorageTier = "primary",
): Promise<number> {
  const { client, bucket } = bindingFor(tier);
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return head.ContentLength ?? 0;
  } catch {
    return 0;
  }
}

export interface ObjectMetadata {
  exists: boolean;
  size: number;
  contentType?: string;
  etag?: string;
  checksumSha256?: string;
  cacheControl?: string;
}

/** Read the provider metadata used to prove a manifest-owned object. */
export async function getObjectMetadata(
  key: string,
  tier: StorageTier = "primary",
  signal?: AbortSignal,
): Promise<ObjectMetadata> {
  const { client, bucket } = bindingFor(tier);
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: signal },
    );
    return {
      exists: true,
      size: head.ContentLength ?? 0,
      contentType: head.ContentType,
      etag: head.ETag?.replace(/^"|"$/g, ""),
      checksumSha256: head.ChecksumSHA256,
      cacheControl: head.CacheControl,
    };
  } catch (error) {
    if (isMissingObjectError(error)) return { exists: false, size: 0 };
    throw error;
  }
}

/**
 * Stream an object out of S3. Used by the move-to-cold flow.
 */
export async function getObjectStream(
  key: string,
  tier: StorageTier = "primary",
): Promise<{
  body: NodeJS.ReadableStream;
  size: number;
  contentType?: string;
}> {
  const { client, bucket } = bindingFor(tier);
  const resp = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!resp.Body) {
    throw new Error(`Object ${key} returned an empty body`);
  }
  return {
    body: resp.Body as NodeJS.ReadableStream,
    size: resp.ContentLength ?? 0,
    contentType: resp.ContentType,
  };
}

/**
 * Upload a file to storage with retry logic
 */
export async function uploadFile(
  key: string,
  filePath: string,
  contentType?: string,
  tier: StorageTier = "primary",
  signal?: AbortSignal,
  cacheControl?: string,
): Promise<string> {
  const { bucket } = bindingFor(tier);
  // Five short, independently-connected attempts are safer than three
  // retries over one poisoned keep-alive socket.  The manifest wrapper still
  // marks the object uncertain if every attempt fails, so this never weakens
  // the external-effect fence.
  const retryDelaysMs = [1_000, 2_000, 4_000, 8_000] as const;
  const maxRetries = retryDelaysMs.length + 1;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw signal.reason;
    const client = createUploadClient(tier);
    let fileStream: ReturnType<typeof createReadStream> | undefined;
    try {
      const fileStats = await stat(filePath);
      const stream = createReadStream(filePath);
      fileStream = stream;
      const abortStream = () =>
        stream.destroy(
          signal?.reason instanceof Error ? signal.reason : undefined,
        );
      signal?.addEventListener("abort", abortStream, { once: true });

      const mimeType =
        contentType || lookup(filePath) || "application/octet-stream";

      const params: PutObjectCommandInput = {
        Bucket: bucket,
        Key: key,
        Body: fileStream,
        ContentType: mimeType,
        ContentLength: fileStats.size,
        CacheControl: cacheControl,
      };

      try {
        await client.send(new PutObjectCommand(params), {
          abortSignal: signal,
        });
      } finally {
        signal?.removeEventListener("abort", abortStream);
      }

      const publicUrl = getPublicUrl(key, tier);

      logger.info("File uploaded to storage", {
        key,
        tier,
        size: fileStats.size,
        contentType: mimeType,
        url: publicUrl,
      });

      return publicUrl;
    } catch (error) {
      lastError = error as Error;
      logger.warn(`Upload attempt ${attempt} failed`, {
        key,
        tier,
        error: lastError.message,
      });

      if (attempt < maxRetries && !signal?.aborted) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, retryDelaysMs[attempt - 1]);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
    } finally {
      fileStream?.destroy();
      // Destroy the per-attempt handler so a reset socket cannot be reused by
      // the next rendition or linger until the process exits.
      client.destroy();
    }
  }

  throw lastError || new Error("Upload failed after retries");
}

/**
 * Upload a buffer to storage with retry logic
 */
export async function uploadBuffer(
  key: string,
  buffer: Buffer,
  contentType: string,
  tier: StorageTier = "primary",
): Promise<string> {
  const { bucket } = bindingFor(tier);
  const retryDelaysMs = [1_000, 2_000, 4_000, 8_000] as const;
  const maxRetries = retryDelaysMs.length + 1;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = createUploadClient(tier);
    try {
      const params: PutObjectCommandInput = {
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ContentLength: buffer.length,
      };

      await client.send(new PutObjectCommand(params));

      const publicUrl = getPublicUrl(key, tier);

      logger.info("Buffer uploaded to storage", {
        key,
        tier,
        size: buffer.length,
        contentType,
        url: publicUrl,
      });

      return publicUrl;
    } catch (error) {
      lastError = error as Error;
      logger.warn(`Upload attempt ${attempt} failed`, {
        key,
        tier,
        error: lastError.message,
      });

      if (attempt < maxRetries) {
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelaysMs[attempt - 1]),
        );
      }
    } finally {
      client.destroy();
    }
  }

  throw lastError || new Error("Upload failed after retries");
}

// Recovery artifacts are operator-only payloads. They use provider-managed
// server-side encryption and callers verify the provider's HEAD response
// before the CMS is allowed to ledger the artifact as recoverable.
export async function uploadEncryptedRecoveryArtifact(
  key: string,
  buffer: Buffer,
): Promise<void> {
  const { client, bucket } = bindingFor("primary");
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: "application/gzip",
      ContentLength: buffer.length,
      ServerSideEncryption: "AES256",
    }),
  );
}

export async function uploadEncryptedMigrationArtifact(
  key: string,
  body: NodeJS.ReadableStream,
  size: number,
  contentType: string,
): Promise<void> {
  const { client, bucket } = bindingFor("primary");
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body as PutObjectCommandInput["Body"],
      ContentType: contentType,
      ContentLength: size,
      ServerSideEncryption: "AES256",
    }),
  );
}

export async function recoveryArtifactEncryptionVerified(
  key: string,
): Promise<boolean> {
  const { client, bucket } = bindingFor("primary");
  const head = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  return (
    head.ServerSideEncryption === "AES256" ||
    head.ServerSideEncryption === "aws:kms"
  );
}

// Recovery artifacts are private system objects. Callers never receive a
// public URL; CMS records only the opaque key/checksum in its ledger.
export async function readObjectBuffer(
  key: string,
  maxBytes: number,
  tier: StorageTier = "primary",
): Promise<Buffer> {
  const { client, bucket } = bindingFor(tier);
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) throw new Error("storage object has no body");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes)
      throw new Error("storage object exceeds recovery artifact limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

export async function readObjectDigest(
  key: string,
  maxBytes: number,
  tier: StorageTier = "primary",
  signal?: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
  const { createHash } = await import("node:crypto");
  const { client, bucket } = bindingFor(tier);
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { abortSignal: signal },
  );
  if (!response.Body) throw new Error("storage object has no body");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    signal?.throwIfAborted();
    bytes += chunk.length;
    if (bytes > maxBytes)
      throw new Error("storage object exceeds migration artifact limit");
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

/**
 * Upload a stream directly into S3. Used by moveObjectBetweenTiers so we don't
 * have to spool to disk first.
 */
export async function uploadStream(
  key: string,
  body: NodeJS.ReadableStream,
  size: number,
  contentType: string,
  tier: StorageTier = "primary",
): Promise<string> {
  const { client, bucket } = bindingFor(tier);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body as PutObjectCommandInput["Body"],
      ContentType: contentType,
      ContentLength: size,
    }),
  );
  return getPublicUrl(key, tier);
}

/**
 * List every object in the bucket and yield them in pages.
 */
export async function* listAllObjects(
  prefix?: string,
  tier: StorageTier = "primary",
): AsyncGenerator<S3Object[]> {
  const { client, bucket } = bindingFor(tier);
  let continuationToken: string | undefined;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );
    if (resp.Contents && resp.Contents.length > 0) {
      yield resp.Contents;
    }
    continuationToken = resp.IsTruncated
      ? resp.NextContinuationToken
      : undefined;
  } while (continuationToken);
}

export interface StorageUsage {
  usedBytes: number;
  objectCount: number;
  byArtifactType: Record<string, number>;
}

/**
 * Compute live bucket usage by paginating through ListObjectsV2.
 */
export async function computeStorageUsage(
  tier: StorageTier = "primary",
): Promise<StorageUsage> {
  let usedBytes = 0;
  let objectCount = 0;
  const byArtifactType: Record<string, number> = {};

  for await (const page of listAllObjects(undefined, tier)) {
    for (const obj of page) {
      const size = obj.Size ?? 0;
      usedBytes += size;
      objectCount += 1;

      const key = obj.Key ?? "";
      const parts = key.split("/");
      let group = "other";
      if (parts.length >= 3 && parts[0] === "content") {
        const filename = parts[parts.length - 1];
        const dot = filename.lastIndexOf(".");
        group =
          artifactFamilyForKey(key) ??
          (dot > 0 ? filename.slice(0, dot) : filename);
      }
      byArtifactType[group] = (byArtifactType[group] ?? 0) + size;
    }
  }

  return { usedBytes, objectCount, byArtifactType };
}

/**
 * List all keys for a specific content item id.
 */
export async function listContentObjects(
  contentItemId: string,
  tier: StorageTier = "primary",
): Promise<S3Object[]> {
  const prefix = `content/${contentItemId}/`;
  const out: S3Object[] = [];
  for await (const page of listAllObjects(prefix, tier)) {
    out.push(...page);
  }
  return out;
}

/** Complete exact-key inventory for an item in every configured storage tier. */
export async function inventoryPodsResetObjects(
  contentItemId: string,
): Promise<PodsResetInventoryRow[]> {
  if (!/^[0-9a-f-]{36}$/i.test(contentItemId))
    throw new Error("invalid content item identity");
  const bindings = podsResetConfiguredStorageBindings();
  const tiers = bindings.map((binding) => binding.storage_tier);
  const result: PodsResetInventoryRow[] = [];
  for (const storage_tier of tiers) {
    const { bucket } = bindingFor(storage_tier);
    const prefix = `content/${contentItemId}/`;
    for await (const page of listAllObjects(prefix, storage_tier)) {
      for (const object of page) {
        const object_key = String(object.Key ?? "");
        if (!object_key.startsWith(prefix))
          throw new Error(
            "provider returned an object outside the content prefix",
          );
        const etag = String(object.ETag ?? "").replace(/^\"|\"$/g, "");
        if (!etag) throw new Error(`object has no stable ETag: ${object_key}`);
        if (!Number.isSafeInteger(object.Size) || Number(object.Size) < 0)
          throw new Error(`object has no stable size: ${object_key}`);
        result.push({
          content_item_id: contentItemId,
          storage_tier,
          bucket,
          object_key,
          etag,
          size_bytes: Number(object.Size),
        });
        if (result.length > MAX_PODS_RESET_OBJECTS)
          throw new Error(
            `Pods reset inventory exceeds ${MAX_PODS_RESET_OBJECTS} objects`,
          );
      }
    }
  }
  return result.sort((a, b) =>
    `${a.storage_tier}\n${a.bucket}\n${a.object_key}`.localeCompare(
      `${b.storage_tier}\n${b.bucket}\n${b.object_key}`,
    ),
  );
}

export function podsResetConfiguredTiers(): PodsResetTier[] {
  const anyColdSettings = Boolean(
    config.coldStorageEndpoint ||
    config.coldStorageBucket ||
    config.coldStorageAccessKey ||
    config.coldStorageSecretKey,
  );
  if (config.coldStorageEnabled && !isColdTierConfigured())
    throw new Error(
      "cold storage is enabled but its inventory credentials are incomplete",
    );
  if (!config.coldStorageEnabled && anyColdSettings)
    throw new Error(
      "cold storage settings are present but disabled; reset cannot prove a complete tier inventory",
    );
  return isColdTierConfigured() ? ["primary", "cold"] : ["primary"];
}

/**
 * Frozen reset inventory binds every configured tier, including empty ones,
 * to its bucket and non-secret provider endpoint identity. Credential rotation
 * does not change the physical storage identity; changing R2 account/endpoint
 * or bucket does.
 */
export function podsResetConfiguredStorageBindings(): PodsResetStorageBinding[] {
  const tiers = podsResetConfiguredTiers();
  return tiers
    .map((storage_tier) => {
      const endpoint =
        storage_tier === "cold"
          ? config.coldStorageEndpoint
          : config.storageEndpoint;
      if (!endpoint) throw new Error(`${storage_tier} storage endpoint is missing`);
      const parsed = new URL(endpoint);
      const endpointIdentity = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
      return {
        storage_tier,
        bucket: bindingFor(storage_tier).bucket,
        endpoint_fingerprint: createHash("sha256")
          .update(endpointIdentity)
          .digest("hex"),
      };
    })
    .sort((left, right) => left.storage_tier.localeCompare(right.storage_tier));
}

/**
 * Pods reset recognizes only Cloudflare R2's current-key delete model. R2 may
 * expose a UUID for an upload through other interfaces, but this S3 adapter
 * cannot address that upload UUID as a delete precondition. Other providers
 * are rejected until their exact inventory/delete semantics are qualified.
 */
export function podsResetStorageVersionModel(): string {
  podsResetConfiguredTiers();
  const endpoints = [config.storageEndpoint];
  if (isColdTierConfigured()) endpoints.push(config.coldStorageEndpoint!);
  return requireSupportedPodsResetVersionModel(endpoints);
}

/**
 * Delete only frozen Pods reset identities. Provider listing is repeated just
 * before deletion, unknown keys and changed objects block the operation, and
 * readback must prove the full item prefix is empty in every configured tier.
 */
export async function deletePodsResetObjectsExact(
  contentItemId: string,
  expected: PodsResetObjectIdentity[],
  expectedBindings: PodsResetStorageBinding[],
): Promise<{
  storageBindings: PodsResetStorageBinding[];
  deletedCount: number;
  freedBytes: number;
  objectsAbsent: boolean;
  deletedObjects: PodsResetObjectIdentity[];
  alreadyAbsentObjects: PodsResetObjectIdentity[];
}> {
  podsResetStorageVersionModel();
  const configuredBindings = podsResetConfiguredStorageBindings();
  if (
    !validatePodsResetStorageBindings(
      configuredBindings.map((binding) => binding.storage_tier),
      expectedBindings,
    ) ||
    !samePodsResetStorageBindings(expectedBindings, configuredBindings)
  ) {
    throw new Error("storage account or bucket binding changed after approval");
  }
  const current = await inventoryPodsResetObjects(contentItemId);
  if (
    !samePodsResetStorageBindings(
      expectedBindings,
      podsResetConfiguredStorageBindings(),
    )
  ) {
    throw new Error("storage account or bucket binding changed during inventory");
  }
  const diff = comparePodsResetInventory(expected, current);
  if (diff.changed.length || diff.unlisted.length) {
    throw new Error("Pods reset object inventory changed after approval");
  }

  let deletedCount = 0;
  let freedBytes = 0;
  const deletedObjects: PodsResetObjectIdentity[] = [];
  const primary = bindingFor("primary");
  const cold = configuredBindings.some((binding) => binding.storage_tier === "cold")
    ? bindingFor("cold")
    : undefined;
  const identitiesByTierAndKey = new Map<string, PodsResetObjectIdentity>();
  for (const object of expected) {
    identitiesByTierAndKey.set(
      `${object.storage_tier}\n${object.bucket}\n${object.object_key}`,
      object,
    );
  }
  // The provider has no cross-request compare-and-delete transaction. Re-HEAD
  // the immutable manifest identity immediately before deletion and block if
  // a writer replaced it after listing.
  for (let i = 0; i < diff.deletable.length; i += 16) {
    await Promise.all(
      diff.deletable.slice(i, i + 16).map(async (object) => {
        const resolved = object.storage_tier === "primary" ? primary : cold;
        if (!resolved)
          throw new Error(
            "approved cold object has no configured cold storage tier",
          );
        if (resolved.bucket !== object.bucket)
          throw new Error("storage bucket binding changed after approval");
        const head = await resolved.client.send(
          new HeadObjectCommand({
            Bucket: resolved.bucket,
            Key: object.object_key,
          }),
        );
        const etag = String(head.ETag ?? "").replace(/^\"|\"$/g, "");
        if (
          etag !== object.etag ||
          Number(head.ContentLength ?? 0) !== object.size_bytes
        )
          throw new Error(
            `object fingerprint changed before delete: ${object.object_key}`,
          );
      }),
    );
  }
  for (const tier of ["primary", "cold"] as const) {
    const keys = diff.deletable
      .filter((object) => object.storage_tier === tier)
      .map((object) => object.object_key);
    if (keys.length === 0) continue;
    const result = await deleteObjectsByKeys(keys, tier);
    if (result.errors.length) throw new Error(result.errors.join("; "));
    deletedCount += result.deletedCount;
    freedBytes += result.freedBytes;
    for (const key of result.deletedKeys) {
      const identity = identitiesByTierAndKey.get(
        `${tier}\n${bindingFor(tier).bucket}\n${key}`,
      );
      if (!identity)
        throw new Error(
          "provider reported deletion outside the approved manifest",
        );
      deletedObjects.push(identity);
    }
  }

  const remaining = await inventoryPodsResetObjects(contentItemId);
  const finalBindings = podsResetConfiguredStorageBindings();
  if (!samePodsResetStorageBindings(expectedBindings, finalBindings)) {
    throw new Error("storage account or bucket binding changed before absence readback");
  }
  const objectsAbsent = remaining.length === 0;
  if (!objectsAbsent)
    throw new Error(
      "Pods reset provider readback found remaining item objects",
    );
  return {
    storageBindings: finalBindings,
    deletedCount,
    freedBytes,
    objectsAbsent,
    deletedObjects,
    alreadyAbsentObjects: diff.missing,
  };
}

/**
 * Delete a single object. Returns the freed bytes (best-effort via HEAD).
 */
export async function deleteObject(
  key: string,
  tier: StorageTier = "primary",
): Promise<number> {
  const { client, bucket } = bindingFor(tier);
  let size = 0;
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    size = head.ContentLength ?? 0;
  } catch {
    // Object may already be missing — fall through and try delete anyway
  }
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  return size;
}

/**
 * Delete a batch of keys (max 1000 per S3 call). Returns freed bytes total
 * and any per-key errors.
 */
export async function deleteObjectsByKeys(
  keys: string[],
  tier: StorageTier = "primary",
): Promise<{
  deletedCount: number;
  freedBytes: number;
  errors: string[];
  deletedKeys: string[];
}> {
  if (keys.length === 0) {
    return { deletedCount: 0, freedBytes: 0, errors: [], deletedKeys: [] };
  }

  const { client, bucket } = bindingFor(tier);
  let deletedCount = 0;
  let freedBytes = 0;
  const errors: string[] = [];
  const deletedKeys: string[] = [];

  const sizeMap = new Map<string, number>();
  for (let i = 0; i < keys.length; i += 16) {
    await Promise.all(
      keys.slice(i, i + 16).map(async (key) => {
        try {
          const head = await client.send(
            new HeadObjectCommand({ Bucket: bucket, Key: key }),
          );
          sizeMap.set(key, head.ContentLength ?? 0);
        } catch {
          // ignore — object may not exist
        }
      }),
    );
  }

  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const objects: ObjectIdentifier[] = batch.map((Key) => ({ Key }));
    try {
      const resp = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: false },
        }),
      );
      for (const deleted of resp.Deleted ?? []) {
        if (deleted.Key) {
          deletedCount += 1;
          freedBytes += sizeMap.get(deleted.Key) ?? 0;
          deletedKeys.push(deleted.Key);
        }
      }
      for (const err of resp.Errors ?? []) {
        errors.push(`${err.Key}: ${err.Message}`);
      }
    } catch (err) {
      errors.push(`batch ${i / 1000}: ${(err as Error).message}`);
    }
  }

  return { deletedCount, freedBytes, errors, deletedKeys };
}

/**
 * Delete every artifact for a single content item.
 */
export async function deleteContentObjects(
  contentItemId: string,
  artifacts?: string[],
  tier: StorageTier = "primary",
): Promise<{
  deletedCount: number;
  freedBytes: number;
  errors: string[];
  objectsAbsent: boolean;
  requestedArtifactsAbsent: boolean;
}> {
  const all = await listContentObjects(contentItemId, tier);
  let keys = all.map((o) => o.Key!).filter(Boolean);
  if (artifacts && artifacts.length > 0) {
    const setLike = new Set(artifacts);
    keys = keys.filter((key) => matchesArtifactFamily(key, setLike));
  }
  const result = await deleteObjectsByKeys(keys, tier);
  let objectsAbsent = false;
  let requestedArtifactsAbsent = false;
  if (result.errors.length === 0) {
    try {
      const remaining = await listContentObjects(contentItemId, tier);
      objectsAbsent = remaining.length === 0;
      const selectedRemaining =
        artifacts && artifacts.length > 0
          ? remaining
              .map((object) => object.Key ?? "")
              .filter(Boolean)
              .filter((key) => matchesArtifactFamily(key, new Set(artifacts)))
          : remaining.map((object) => object.Key ?? "").filter(Boolean);
      if (selectedRemaining.length > 0) {
        result.errors.push("provider readback found remaining content objects");
      } else {
        requestedArtifactsAbsent = true;
      }
    } catch (error) {
      result.errors.push(
        `provider deletion readback failed: ${(error as Error).message}`,
      );
    }
  }
  return { ...result, objectsAbsent, requestedArtifactsAbsent };
}

/** Classify canonical, versioned, HLS, and repair artifacts by lifecycle family. */
export function artifactFamilyForKey(
  key: string,
): "processed" | "original" | "thumbnail" | undefined {
  const relative = key.split("/").slice(2).join("/");
  const root = relative.split("/")[0] ?? "";
  const filename = relative.split("/").pop() ?? "";
  if (root === "hls") return "processed";
  for (const artifact of ["processed", "original", "thumbnail"] as const) {
    if (
      root === artifact ||
      root.startsWith(`${artifact}.`) ||
      root.startsWith(`${artifact}_`) ||
      filename === artifact ||
      filename.startsWith(`${artifact}.`) ||
      filename.startsWith(`${artifact}_`)
    )
      return artifact;
  }
  return undefined;
}

/** Match an artifact root and all deterministic version/HLS/repair children. */
export function matchesArtifactFamily(
  key: string,
  artifacts: Set<string>,
): boolean {
  const family = artifactFamilyForKey(key);
  return family !== undefined && artifacts.has(family);
}

/**
 * Delete only the provider objects frozen by a recovery saga. A URL reference
 * may be either the configured public URL or the canonical storage key.
 * Readback is strict: any unlisted object left under the content prefix makes
 * the operation fail closed instead of allowing CMS metadata deletion.
 */
export async function deleteContentObjectsExact(
  contentItemId: string,
  references: string[],
  tier: StorageTier = "primary",
): Promise<{
  deletedCount: number;
  freedBytes: number;
  errors: string[];
  objectsAbsent: boolean;
}> {
  const all = await listContentObjects(contentItemId, tier);
  const normalized = new Set(
    references.map((value) => String(value).trim()).filter(Boolean),
  );
  const keys = all.map((object) => object.Key ?? "").filter(Boolean);
  const matched = keys.filter(
    (key) => normalized.has(key) || normalized.has(getPublicUrl(key, tier)),
  );
  const missing = [...normalized].filter(
    (reference) =>
      !matched.some(
        (key) => key === reference || getPublicUrl(key, tier) === reference,
      ),
  );
  const result = await deleteObjectsByKeys(matched, tier);
  let objectsAbsent = false;
  if (result.errors.length === 0) {
    try {
      const remaining = await listContentObjects(contentItemId, tier);
      objectsAbsent = remaining.length === 0;
      if (!objectsAbsent)
        result.errors.push("provider readback found unlisted content objects");
      // Missing frozen references are safe only when the complete
      // content prefix is already empty. That is the idempotent retry
      // case after a provider succeeded but the previous HTTP response
      // was lost; any remaining object keeps the saga blocked.
      if (missing.length > 0 && objectsAbsent === false) {
        result.errors.push(
          `recovery object map references missing provider objects: ${missing.join(",")}`,
        );
      }
    } catch (error) {
      result.errors.push(
        `provider deletion readback failed: ${(error as Error).message}`,
      );
    }
  }
  return { ...result, objectsAbsent };
}

// -----------------------------------------------------------------------------
// Tier-to-tier movement
// -----------------------------------------------------------------------------

export interface MoveResult {
  movedCount: number;
  bytesMoved: number;
  newPrimaryUrls: Record<string, string>; // artifactType -> new public URL on the cold tier
  errors: string[];
}

/**
 * Move every artifact for a content item from one tier to another by streaming
 * the bytes. Used for primary→cold during circulation, and cold→primary for
 * restore. Returns per-artifact public URLs on the destination tier.
 *
 * Strategy: list source keys, stream each from source S3 → destination S3,
 * verify, then delete from source.
 */
export async function moveObjectBetweenTiers(
  contentItemId: string,
  from: StorageTier,
  to: StorageTier,
  artifacts?: string[],
): Promise<MoveResult> {
  if (from === to) {
    throw new Error("moveObjectBetweenTiers: from and to tiers must differ");
  }
  if (to === "cold" && !isColdTierConfigured()) {
    throw new Error(
      "Cold tier is not configured — set COLD_STORAGE_* env vars",
    );
  }

  const sourceObjs = await listContentObjects(contentItemId, from);
  let keys = sourceObjs.map((o) => o.Key!).filter(Boolean);
  if (artifacts && artifacts.length > 0) {
    const setLike = new Set(artifacts);
    keys = keys.filter((key) => matchesArtifactFamily(key, setLike));
  }

  const result: MoveResult = {
    movedCount: 0,
    bytesMoved: 0,
    newPrimaryUrls: {},
    errors: [],
  };

  for (const key of keys) {
    try {
      const src = await getObjectStream(key, from);
      await uploadStream(
        key,
        src.body,
        src.size,
        src.contentType ?? "application/octet-stream",
        to,
      );
      const destination = await getObjectMetadata(key, to);
      if (!destination.exists || destination.size !== src.size) {
        throw new Error("destination readback did not match the source size");
      }
      if (src.contentType && destination.contentType && destination.contentType !== src.contentType) {
        throw new Error("destination readback did not match the source content type");
      }

      // Do not remove the origin until the destination is readable and exact.
      await deleteObject(key, from);
      if (await objectExists(key, from)) {
        throw new Error("source object remains after the delete request");
      }
      result.movedCount += 1;
      result.bytesMoved += src.size;

      const file = key.split("/").pop() ?? "";
      const dot = file.lastIndexOf(".");
      const artifactType = dot > 0 ? file.slice(0, dot) : file;
      result.newPrimaryUrls[artifactType] = getPublicUrl(key, to);
    } catch (err) {
      result.errors.push(`${key}: ${(err as Error).message}`);
      logger.error("moveObjectBetweenTiers: failed for key", err, {
        key,
        from,
        to,
      });
    }
  }

  return result;
}

export const storageClient = {
  getStorageKey,
  getPublicUrl,
  objectExists,
  getObjectSize,
  getObjectMetadata,
  getObjectStream,
  uploadFile,
  uploadBuffer,
  uploadEncryptedRecoveryArtifact,
  recoveryArtifactEncryptionVerified,
  readObjectBuffer,
  uploadStream,
  listAllObjects,
  listContentObjects,
  inventoryPodsResetObjects,
  podsResetConfiguredTiers,
  computeStorageUsage,
  deleteObject,
  deleteObjectsByKeys,
  deleteContentObjects,
  deleteContentObjectsExact,
  moveObjectBetweenTiers,
  isColdTierConfigured,
  s3Client,
  primaryClient,
  coldClient,
};
