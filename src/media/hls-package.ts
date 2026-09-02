import { createHash } from "crypto";
import { mkdir, readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { cmsClient } from "../cms/client.js";
import { uploadFileWithManifest } from "../storage/manifest.js";
import {
  createAdaptiveHlsPackage,
  createHlsAccessMaster,
  validateAdaptiveHlsPackage,
  type FfmpegRunOptions,
} from "./transcoder.js";
import { snapshotDigest } from "./route-planner.js";

export interface UploadedAdaptiveHlsPackage {
  masterUrl: string;
  masterManifestId: string;
  progressiveUrl: string;
  progressiveManifestId: string;
  standardMasterUrl: string;
  standardMasterManifestId: string;
  highMasterUrl: string;
  highMasterManifestId: string;
  packageId: string;
  validationDigest: string;
  manifestIds: string[];
  validationEvidence: Record<string, unknown>;
}

function artifactType(file: string): {
  role:
    | "hls_master"
    | "hls_access_master"
    | "hls_playlist"
    | "hls_init"
    | "hls_segment";
  contentType: string;
  cacheControl: string;
} {
  if (file === "master.m3u8")
    return {
      role: "hls_master",
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: "no-cache, max-age=0, must-revalidate",
    };
  if (file === "standard.m3u8" || file === "high.m3u8")
    return {
      role: "hls_access_master",
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: "no-cache, max-age=0, must-revalidate",
    };
  if (file.endsWith(".m3u8"))
    return {
      role: "hls_playlist",
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: "no-cache, max-age=0, must-revalidate",
    };
  if (file.endsWith("_init.mp4"))
    return {
      role: "hls_init",
      contentType: "video/mp4",
      cacheControl: "public, max-age=31536000, immutable",
    };
  return {
    role: "hls_segment",
    contentType: file.startsWith("audio_")
      ? "audio/iso.segment"
      : "video/iso.segment",
    cacheControl: "public, max-age=31536000, immutable",
  };
}

async function fileEvidence(
  dir: string,
  file: string,
): Promise<Record<string, unknown>> {
  const bytes = await readFile(join(dir, file));
  return {
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Builds, uploads, and CMS-verifies one immutable CMAF package. No caller may
 * activate an HLS rendition without this receipt. */
export async function createAndUploadAdaptiveHlsPackage(input: {
  tenantId: string;
  contentItemId: string;
  renditionGenerationId: string;
  attemptId?: string;
  fenceToken?: string;
  sourcePath: string;
  outputDir: string;
  storagePrefix: string;
  progressivePath: string;
  progressiveManifestId: string;
  inputDigest: string;
  signal?: AbortSignal;
}): Promise<UploadedAdaptiveHlsPackage> {
  await mkdir(input.outputDir, { recursive: true });
  const generated = await createAdaptiveHlsPackage(
    input.sourcePath,
    input.outputDir,
    { signal: input.signal } satisfies FfmpegRunOptions,
  );
  const standard = await createHlsAccessMaster(
    input.outputDir,
    generated.variants,
    "standard",
  );
  const high = await createHlsAccessMaster(
    input.outputDir,
    generated.variants,
    "high",
  );
  const validation = await validateAdaptiveHlsPackage(input.outputDir);
  const files = (await readdir(input.outputDir))
    .filter((file) => file !== "fallback.mp4")
    .sort(
      (a, b) =>
        Number(b === "master.m3u8") - Number(a === "master.m3u8") ||
        a.localeCompare(b),
    );
  const manifestIds: string[] = [];
  let masterManifestId = "";
  let masterUrl = "";
  let standardMasterManifestId = "";
  let standardMasterUrl = "";
  let highMasterManifestId = "";
  let highMasterUrl = "";
  const evidenceFiles: Record<string, unknown>[] = [];
  for (const file of files) {
    const path = join(input.outputDir, file);
    if (!(await stat(path)).isFile()) continue;
    const details = artifactType(file);
    const uploaded = await uploadFileWithManifest(
      {
        tenantId: input.tenantId,
        contentItemId: input.contentItemId,
        parentContentItemId: input.contentItemId,
        attemptId: input.attemptId,
        artifactRole: details.role,
        packageManifestId:
          file === "master.m3u8" ? undefined : masterManifestId,
        key: `${input.storagePrefix}/hls/${file}`,
        filePath: path,
        contentType: details.contentType,
        cacheControl: details.cacheControl,
        inputDigest: input.inputDigest,
        fenceToken: input.fenceToken,
        creatorRole: "aggregation-media-executor",
      },
      input.signal,
    );
    if (file === "master.m3u8") {
      masterManifestId = uploaded.manifestId;
      masterUrl = uploaded.url;
    }
    if (file === "standard.m3u8") {
      standardMasterManifestId = uploaded.manifestId;
      standardMasterUrl = uploaded.url;
    }
    if (file === "high.m3u8") {
      highMasterManifestId = uploaded.manifestId;
      highMasterUrl = uploaded.url;
    }
    manifestIds.push(uploaded.manifestId);
    evidenceFiles.push({
      ...(await fileEvidence(input.outputDir, file)),
      manifest_id: uploaded.manifestId,
      url: uploaded.url,
      content_type: details.contentType,
      provider_head_verified: true,
      provider_size_bytes: uploaded.bytes,
      provider_etag: uploaded.providerEtag,
      provider_checksum_sha256: uploaded.providerChecksumSha256,
      provider_content_type: uploaded.providerContentType,
      provider_cache_control: uploaded.providerCacheControl,
      cache_control: details.cacheControl,
    });
  }
  if (
    !masterManifestId ||
    !masterUrl ||
    !standardMasterManifestId ||
    !standardMasterUrl ||
    !highMasterManifestId ||
    !highMasterUrl
  )
    throw new Error(
      "adaptive package has no uploaded serving master manifests",
    );
  const progressive = await uploadFileWithManifest(
    {
      tenantId: input.tenantId,
      contentItemId: input.contentItemId,
      parentContentItemId: input.contentItemId,
      attemptId: input.attemptId,
      artifactRole: "delivery_progressive",
      key: `${input.storagePrefix}/hls/fallback.mp4`,
      filePath: generated.progressiveFallbackPath,
      contentType: "video/mp4",
      cacheControl: "public, max-age=31536000, immutable",
      inputDigest: input.inputDigest,
      fenceToken: input.fenceToken,
      creatorRole: "aggregation-media-executor",
    },
    input.signal,
  );
  manifestIds.push(progressive.manifestId);
  const progressiveEvidence = {
    ...(await fileEvidence(input.outputDir, "fallback.mp4")),
    manifest_id: progressive.manifestId,
    url: progressive.url,
    content_type: "video/mp4",
    provider_head_verified: true,
    provider_size_bytes: progressive.bytes,
    provider_etag: progressive.providerEtag,
    provider_checksum_sha256: progressive.providerChecksumSha256,
    provider_content_type: progressive.providerContentType,
    provider_cache_control: progressive.providerCacheControl,
    cache_control: "public, max-age=31536000, immutable",
  };
  const evidence = {
    ...validation.evidence,
    files: [...evidenceFiles, progressiveEvidence],
    master_manifest_id: masterManifestId,
    progressive_manifest_id: progressive.manifestId,
    source_digest: input.inputDigest,
  };
  const pkg = await cmsClient.createMediaHLSPackage({
    tenant_id: input.tenantId,
    rendition_generation_id: input.renditionGenerationId,
    master_manifest_id: masterManifestId,
    progressive_manifest_id: progressive.manifestId,
    variant_count: Number(validation.evidence.variant_count ?? 0),
  });
  const validationDigest = snapshotDigest(evidence);
  await cmsClient.verifyMediaHLSPackage(pkg.id, {
    tenant_id: input.tenantId,
    rendition_generation_id: input.renditionGenerationId,
    master_manifest_id: masterManifestId,
    progressive_manifest_id: progressive.manifestId,
    variant_count: Number(validation.evidence.variant_count ?? 0),
    validation_evidence: evidence,
    validation_digest: validationDigest,
  });
  await cmsClient.createMediaHLSAccessPoint({
    tenant_id: input.tenantId,
    package_id: pkg.id,
    quality_tier: "standard",
    manifest_id: standardMasterManifestId,
    max_height: standard.maxHeight,
    max_bandwidth_kbps: standard.maxBandwidthKbps,
    validation_digest: validationDigest,
  });
  await cmsClient.createMediaHLSAccessPoint({
    tenant_id: input.tenantId,
    package_id: pkg.id,
    quality_tier: "high",
    manifest_id: highMasterManifestId,
    max_height: high.maxHeight,
    max_bandwidth_kbps: high.maxBandwidthKbps,
    validation_digest: validationDigest,
  });
  return {
    masterUrl,
    masterManifestId,
    standardMasterUrl,
    standardMasterManifestId,
    highMasterUrl,
    highMasterManifestId,
    packageId: pkg.id,
    validationDigest,
    progressiveUrl: progressive.url,
    progressiveManifestId: progressive.manifestId,
    manifestIds,
    validationEvidence: evidence,
  };
}
