import { createHash } from "node:crypto";
import { createReadStream } from "fs";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config/index.js";
import { cmsClient } from "../cms/client.js";
import {
  getObjectMetadata,
  getPublicUrl,
  uploadFile,
  type StorageTier,
} from "./client.js";

export interface ManifestUploadInput {
  tenantId?: string;
  contentItemId?: string;
  parentContentItemId?: string;
  atomizationGenerationId?: string;
  atomizationChapterUnitId?: string;
  transcriptionGenerationId?: string;
  transcriptionSegmentUnitId?: string;
  attemptId?: string;
  artifactRole:
    | "source"
    | "analysis_audio"
    | "chapter_media"
    | "chapter_hls"
    | "thumbnail"
    | "transcript_segment"
    | "playback_audio"
    | "playback_mp4"
    | "delivery_audio"
    | "delivery_progressive"
    | "hls_master"
    | "hls_access_master"
    | "hls_playlist"
    | "hls_init"
    | "hls_segment";
  packageManifestId?: string;
  cacheControl?: string;
  key: string;
  filePath: string;
  contentType: string;
  tier?: StorageTier;
  inputDigest: string;
  fenceToken?: string;
  creatorRole: string;
}

interface LocalDigest {
  bytes: number;
  sha256: string;
  md5: string;
}

async function digestFile(filePath: string): Promise<LocalDigest> {
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const value = chunk as Buffer;
    bytes += value.length;
    sha256.update(value);
    md5.update(value);
  }
  return { bytes, sha256: sha256.digest("hex"), md5: md5.digest("hex") };
}

function normalizeContentType(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function normalizeEtag(value: string | undefined): string {
  return (value ?? "").replace(/^"|"$/g, "").toLowerCase();
}

function verifyProviderMetadata(
  metadata: Awaited<ReturnType<typeof getObjectMetadata>>,
  expected: {
    bytes: number;
    contentType: string;
    cacheControl?: string;
    md5?: string;
    etag?: string;
  },
): void {
  if (!metadata.exists || metadata.size !== expected.bytes) {
    throw new Error(
      `manifest provider size mismatch: expected ${expected.bytes}, got ${metadata.size}`,
    );
  }
  const expectedType = normalizeContentType(expected.contentType);
  const providerType = normalizeContentType(metadata.contentType);
  if (expectedType && providerType && expectedType !== providerType) {
    throw new Error(
      `manifest provider content-type mismatch: expected ${expectedType}, got ${providerType}`,
    );
  }
  if (
    expected.cacheControl &&
    (metadata.cacheControl ?? "").trim() !== expected.cacheControl.trim()
  ) {
    throw new Error(
      `manifest provider cache-control mismatch for ${expected.bytes} bytes`,
    );
  }
  const providerEtag = normalizeEtag(metadata.etag);
  // PutObject is single-part in this path, so a plain MD5 ETag is an exact
  // provider-side checksum. Multipart-style ETags are recorded but not used
  // as a false checksum assertion.
  if (
    expected.md5 &&
    providerEtag &&
    /^[a-f0-9]{32}$/.test(providerEtag) &&
    providerEtag !== expected.md5
  ) {
    throw new Error(
      `manifest provider ETag mismatch for ${expected.bytes} bytes`,
    );
  }
}

export async function uploadFileWithManifest(
  input: ManifestUploadInput,
  signal?: AbortSignal,
): Promise<{ url: string; manifestId: string; bytes: number }> {
  const tier = input.tier ?? "primary";
  const bucket =
    tier === "cold"
      ? (config.coldStorageBucket ?? config.storageBucket)
      : config.storageBucket;
  const url = getPublicUrl(input.key, tier);
  const digest = await digestFile(input.filePath);
  const bytes = digest.bytes;
  const producerEventId = uuidv4();
  const manifest = await cmsClient.createArtifactManifest(
    {
      tenant_id: input.tenantId ?? "default",
      content_item_id: input.contentItemId,
      parent_content_item_id: input.parentContentItemId,
      atomization_generation_id: input.atomizationGenerationId,
      atomization_chapter_unit_id: input.atomizationChapterUnitId,
      transcription_generation_id: input.transcriptionGenerationId,
      transcription_segment_unit_id: input.transcriptionSegmentUnitId,
      attempt_id: input.attemptId,
      artifact_role: input.artifactRole,
      package_manifest_id: input.packageManifestId,
      storage_tier: tier,
      bucket,
      object_key: input.key,
      public_url: url,
      content_type: input.contentType,
      cache_control: input.cacheControl,
      size_bytes: bytes,
      sha256: digest.sha256,
      creator_role: input.creatorRole,
      producer_event_id: producerEventId,
      fence_token: input.fenceToken,
      input_digest: input.inputDigest,
    },
    producerEventId,
    signal,
  );
  try {
    if (manifest.state === "verified" || manifest.state === "active") {
      const metadata = await getObjectMetadata(input.key, tier, signal);
      verifyProviderMetadata(metadata, {
        bytes,
        contentType: input.contentType,
        cacheControl: input.cacheControl,
        md5: undefined,
        etag: manifest.etag ?? undefined,
      });
      if (
        manifest.etag &&
        normalizeEtag(manifest.etag) !== normalizeEtag(metadata.etag)
      ) {
        throw new Error(`existing manifest ETag mismatch for ${input.key}`);
      }
      return { url, manifestId: manifest.id, bytes: metadata.size };
    }
    await uploadFile(
      input.key,
      input.filePath,
      input.contentType,
      tier,
      signal,
      input.cacheControl,
    );
    const metadata = await getObjectMetadata(input.key, tier, signal);
    verifyProviderMetadata(metadata, {
      bytes,
      contentType: input.contentType,
      cacheControl: input.cacheControl,
      md5: digest.md5,
    });
    await cmsClient.transitionArtifactManifest(
      manifest.id,
      "uploaded",
      {
        tenant_id: input.tenantId ?? "default",
        producer_event_id: producerEventId,
        fence_token: input.fenceToken,
        size_bytes: bytes,
        public_url: url,
        etag: metadata.etag,
        sha256: digest.sha256,
      },
      producerEventId,
      signal,
    );
    await cmsClient.transitionArtifactManifest(
      manifest.id,
      "verified",
      {
        tenant_id: input.tenantId ?? "default",
        producer_event_id: producerEventId,
        fence_token: input.fenceToken,
        size_bytes: metadata.size,
        etag: metadata.etag,
        sha256: digest.sha256,
        content_type: input.contentType,
        verification_evidence: {
          local_size_verified: true,
          provider_head_verified: true,
          provider_size_bytes: metadata.size,
          provider_content_type: metadata.contentType,
          provider_etag: metadata.etag,
          provider_checksum_sha256: metadata.checksumSha256,
          local_sha256: digest.sha256,
          local_md5_matches_etag: Boolean(
            metadata.etag && normalizeEtag(metadata.etag) === digest.md5,
          ),
        },
      },
      producerEventId,
      signal,
    );
    return { url, manifestId: manifest.id, bytes };
  } catch (error) {
    await cmsClient
      .transitionArtifactManifest(
        manifest.id,
        "uncertain",
        {
          tenant_id: input.tenantId ?? "default",
          producer_event_id: producerEventId,
          fence_token: input.fenceToken,
          terminal_proof: {
            error: error instanceof Error ? error.message : "upload_failed",
          },
        },
        producerEventId,
      )
      .catch(() => undefined);
    throw error;
  }
}

/** Register an already-uploaded object during idempotent repair. */
export async function registerExistingObjectWithManifest(
  input: Omit<ManifestUploadInput, "filePath">,
): Promise<{ url: string; manifestId: string; bytes: number }> {
  const tier = input.tier ?? "primary";
  const bucket =
    tier === "cold"
      ? (config.coldStorageBucket ?? config.storageBucket)
      : config.storageBucket;
  const url = getPublicUrl(input.key, tier);
  const metadata = await getObjectMetadata(input.key, tier);
  if (!metadata.exists)
    throw new Error(`cannot register missing object ${input.key}`);
  const producerEventId = uuidv4();
  const manifest = await cmsClient.createArtifactManifest(
    {
      tenant_id: input.tenantId ?? "default",
      content_item_id: input.contentItemId,
      parent_content_item_id: input.parentContentItemId,
      artifact_role: input.artifactRole,
      storage_tier: tier,
      bucket,
      object_key: input.key,
      public_url: url,
      content_type: input.contentType,
      size_bytes: metadata.size,
      etag: metadata.etag,
      creator_role: input.creatorRole,
      producer_event_id: producerEventId,
      fence_token: input.fenceToken,
      input_digest: input.inputDigest,
      recovery_class: "existing_object_repair",
      verification_evidence: {
        existing_object_recovery: true,
        provider_head_verified: true,
      },
    },
    producerEventId,
  );
  if (manifest.state === "verified" || manifest.state === "active") {
    verifyProviderMetadata(metadata, {
      bytes: metadata.size,
      contentType: input.contentType,
      etag: manifest.etag ?? undefined,
    });
    return { url, manifestId: manifest.id, bytes: metadata.size };
  }
  await cmsClient.transitionArtifactManifest(
    manifest.id,
    "uploaded",
    {
      tenant_id: input.tenantId ?? "default",
      producer_event_id: producerEventId,
      fence_token: input.fenceToken,
      size_bytes: metadata.size,
      etag: metadata.etag,
      public_url: url,
    },
    producerEventId,
  );
  await cmsClient.transitionArtifactManifest(
    manifest.id,
    "verified",
    {
      tenant_id: input.tenantId ?? "default",
      producer_event_id: producerEventId,
      fence_token: input.fenceToken,
      size_bytes: metadata.size,
      etag: metadata.etag,
      content_type: input.contentType,
      verification_evidence: {
        existing_object_recovery: true,
        provider_head_verified: true,
        provider_content_type: metadata.contentType,
      },
    },
    producerEventId,
  );
  return { url, manifestId: manifest.id, bytes: metadata.size };
}
