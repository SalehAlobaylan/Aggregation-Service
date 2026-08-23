import { Job } from "bullmq";
import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { join } from "path";
import { readdir, rm, stat } from "fs/promises";
import { createWorker } from "./base-worker.js";
import { getQueue, QUEUE_NAMES, type AtomizationJob } from "../queues/index.js";
import { cmsClient, contentStageCorrelation } from "../cms/client.js";
import { config } from "../config/index.js";
import { downloadHttp, cleanupTempFile } from "../media/downloader.js";
import {
  createHlsVod,
  cutMediaSegment,
  extractThumbnail,
  getMediaInfo,
} from "../media/transcoder.js";
import {
  uploadFile,
  getStorageKey,
  getPublicUrl,
  objectExists,
  listContentObjects,
  type StorageTier,
} from "../storage/client.js";
import { uploadFileWithManifest } from "../storage/manifest.js";
import { generateChaptersViaEnrichment } from "../ai/enrichment-client.js";
import type {
  AtomizationChapter,
  AtomizationInputResponse,
  MediaRendition,
} from "../cms/types.js";
import {
  buildChapterEmbeddingJobs,
  buildWindows,
  compatibilityChapterChildren,
  countReviewChapters,
  enforceFullCoverage,
  minFeedUnitSeconds,
  normalizeGeneratedChapters,
  planningChapterCount,
  shouldAtomizeParent,
  sliceSegments,
} from "./atomization.helpers.js";
import { withResourceLease } from "../runtime/resource-admission.js";
import { ResourceDeferredError } from "../runtime/resource-admission.js";
import {
  reserveLocalScratch,
  type LocalReservation,
} from "../runtime/local-reservations.js";

const HLS_UPLOAD_CONCURRENCY = 6;

export const atomizationWorker = createWorker({
  queueName: QUEUE_NAMES.ATOMIZATION,
  concurrency: 1,
  timeoutMs: config.mediaJobTimeoutMs,
  processor: async (
    job: Job<AtomizationJob>,
    jobLogger,
    signal,
  ): Promise<void> => {
    const { contentItemId } = job.data;
    const stageClaim = job.data.contentStageClaim;
    const governed =
      job.data.workRequestId && job.data.workClaimToken
        ? {
            id: job.data.workRequestId,
            claimToken: job.data.workClaimToken,
            attemptId: job.data.workAttemptId,
          }
        : undefined;
    jobLogger.info("Processing atomization job", {
      contentItemId,
      reason: job.data.reason,
    });

    let runId: string | undefined;
    let currentPhase:
      "planning" | "cutting" | "renditions" | "children" | "embedding" =
      "planning";
    const report = async (
      status: "queued" | "running" | "completed" | "needs_review" | "failed",
      phase: "planning" | "cutting" | "renditions" | "children" | "embedding",
      extra: {
        child_count?: number;
        review_count?: number;
        error_message?: string;
      } = {},
    ): Promise<void> => {
      currentPhase = phase;
      const response = await cmsClient.reportAtomizationRun(
        contentItemId,
        { run_id: runId, status, phase, trigger: job.data.reason, ...extra },
        job.id,
        signal,
      );
      runId = response.run_id;
    };

    let stageHeartbeat: NodeJS.Timeout | undefined;
    try {
      if (stageClaim) {
        await cmsClient.beginContentStage(stageClaim, job.id);
        stageHeartbeat = setInterval(
          () =>
            void cmsClient
              .heartbeatContentStage(stageClaim, job.id)
              .catch(() => undefined),
          15_000,
        );
        stageHeartbeat.unref();
      }
      if (governed) await cmsClient.beginAtomizationWork(governed, job.id);
      await report("running", "planning");
      const input = await cmsClient.getAtomizationInput(
        contentItemId,
        job.id,
        signal,
      );
      if (!input.policy.chaptering_enabled) {
        jobLogger.info("Atomization disabled by source policy", {
          contentItemId,
        });
        if (stageClaim) {
          await cmsClient.settleAtomizationNotRequired(
            stageClaim,
            "CMS atomization policy is disabled",
            job.id,
          );
        }
        await report("completed", "planning");
        return;
      }
      if (
        !shouldAtomizeParent(
          input.item.duration_sec,
          input.policy.atomization_min_parent_seconds,
        )
      ) {
        jobLogger.info(
          "Atomization skipped because parent is not longer than 40 minutes",
          {
            contentItemId,
            durationSec: input.item.duration_sec,
          },
        );
        if (stageClaim) {
          await cmsClient.settleAtomizationNotRequired(
            stageClaim,
            "Parent duration no longer requires atomization",
            job.id,
          );
        }
        await report("completed", "planning");
        return;
      }
      if (!input.item.media_url) {
        throw new Error(`Parent ${contentItemId} has no media_url`);
      }
      if (!input.transcript || input.segments.length === 0) {
        throw new Error(
          `Parent ${contentItemId} has no timestamped transcript yet`,
        );
      }

      const windows = buildWindows(input.segments);
      const generated = await generateChaptersViaEnrichment(windows, {
        requestId: job.id,
        language: input.transcript.language,
        // The policy value is an editorial density preference. A valid long
        // parent still needs enough legal units to cover its full timeline.
        maxChapters: planningChapterCount(input),
        minSec: minFeedUnitSeconds(input),
        maxSec: input.policy.hard_max_chapter_minutes * 60,
        signal,
      });
      const normalizedChapters = normalizeGeneratedChapters(
        generated,
        windows,
        input,
      );
      const chapters = enforceFullCoverage(normalizedChapters, input);
      await cmsClient.saveAtomizationPlan(
        contentItemId,
        chapters,
        job.id,
        signal,
      );
      const planDigest = createHash("sha256")
        .update(JSON.stringify(chapters))
        .digest("hex");
      const coverageDigest = createHash("sha256")
        .update(
          JSON.stringify(
            chapters.map(({ start_ms, end_ms }) => ({ start_ms, end_ms })),
          ),
        )
        .digest("hex");
      const generationResponse = await cmsClient.createAtomizationGeneration(
        {
          tenant_id: input.item.tenant_id,
          parent_content_item_id: contentItemId,
          work_request_id: governed?.id ?? uuidv4(),
          transcript_digest: createHash("sha256")
            .update(input.transcript.full_text)
            .digest("hex"),
          policy_digest: createHash("sha256")
            .update(JSON.stringify(input.policy))
            .digest("hex"),
          input_digest: job.data.workInputFingerprint ?? planDigest,
          plan_digest: planDigest,
          coverage_digest: coverageDigest,
          chapters,
        },
        job.id,
        signal,
      );
      if (governed)
        await cmsClient.checkpointAtomizationWork(
          {
            ...governed,
            phase: "plan_persisted",
            proof: {
              input_fingerprint: job.data.workInputFingerprint,
              chapter_count: chapters.length,
            },
          },
          job.id,
        );
      await report("running", "cutting");

      const tempFiles: string[] = [];
      const tempDirs: string[] = [];
      let localReservation: LocalReservation | undefined;
      let reservationHeartbeat: NodeJS.Timeout | undefined;
      try {
        const estimatedBytes = Math.max(
          512 * 1024 * 1024,
          (input.item.duration_sec ?? 3600) * 256 * 1024,
        );
        localReservation = await reserveLocalScratch(
          governed?.attemptId ?? job.id?.toString() ?? contentItemId,
          estimatedBytes,
          { contentId: contentItemId, ownerRole: "aggregation-media-executor" },
        );
        reservationHeartbeat = setInterval(
          () => void localReservation?.heartbeat().catch(() => undefined),
          30_000,
        );
        reservationHeartbeat.unref();
        const parentMedia = await resolveParentMediaForAtomization(
          input,
          jobLogger,
        );
        const parentDownload = await downloadHttp(
          parentMedia.url,
          `${contentItemId}_atomize`,
          parentMedia.extension,
          signal,
          localReservation.sourceDir,
        );
        tempFiles.push(parentDownload.filePath);
        const mediaInfo = await getMediaInfo(parentDownload.filePath);

        const children: AtomizationChapter[] = [];
        const existingUnits = await cmsClient.listAtomizationChapterUnits(
          generationResponse.generation.id,
          job.id,
          signal,
        );
        const existingByIndex = new Map(
          existingUnits.units.map((unit) => [unit.unit_index, unit]),
        );
        for (let i = 0; i < chapters.length; i += 1) {
          // Every chapter owns a distinct scratch set. It is removed as soon
          // as uploads have been accepted, so a long parent never retains all
          // completed MP4/HLS/thumb outputs until finalization.
          const chapterTempFiles: string[] = [];
          const chapterTempDirs: string[] = [];
          const attemptSuffix = String(job.id ?? "attempt").replace(
            /[^a-zA-Z0-9_-]/g,
            "_",
          );
          if (governed)
            await cmsClient.heartbeatAtomizationWork(governed, job.id);
          const existingUnit = existingByIndex.get(i);
          if (existingUnit?.state === "verified" && existingUnit.result) {
            children.push(existingUnit.result);
            continue;
          }
          const unitClaim = await cmsClient.claimAtomizationChapterUnit(
            job.id,
            generationResponse.generation.id,
          );
          if (!unitClaim || unitClaim.unit.unit_index !== i) {
            throw new Error(`atomization unit ${i} could not be claimed`);
          }
          const unitId = unitClaim.unit.id;
          const unitToken = unitClaim.unit.claim_token ?? "";
          const unitArtifactPrefix = `${contentItemId}/generations/${generationResponse.generation.id}/chapters/${i}/attempts/${unitClaim.unit.attempt_count}`;
          await cmsClient.transitionAtomizationChapterUnit(
            unitId,
            "running",
            { claim_token: unitToken },
            job.id,
            signal,
          );
          const chapter = chapters[i]!;
          const clipPath = join(
            localReservation.outputDir,
            `${contentItemId}_${attemptSuffix}_chapter_${i}.mp4`,
          );
          const startSec = chapter.start_ms / 1000;
          const durationSec = Math.max(
            1,
            (chapter.end_ms - chapter.start_ms) / 1000,
          );
          const cut = await withResourceLease(
            "software_encode",
            "required",
            () =>
              cutMediaSegment(
                parentDownload.filePath,
                clipPath,
                startSec,
                durationSec,
                undefined,
                { signal },
              ),
          );
          chapterTempFiles.push(clipPath);
          tempFiles.push(clipPath); // final safety net if this chapter throws
          if (governed && i === 0)
            await cmsClient.checkpointAtomizationWork(
              { ...governed, phase: "first_cut", proof: { chapter_index: 0 } },
              job.id,
            );

          currentPhase = "renditions";
          const mp4Key = getStorageKey(
            unitArtifactPrefix,
            "processed",
            "mp4",
          );
          const mp4Upload = await uploadFileWithManifest(
            {
              tenantId: input.item.tenant_id,
              parentContentItemId: contentItemId,
              atomizationGenerationId: generationResponse.generation.id,
              atomizationChapterUnitId: unitId,
              attemptId: governed?.attemptId,
              artifactRole: "chapter_media",
              key: mp4Key,
              filePath: clipPath,
              contentType: "video/mp4",
              inputDigest: createHash("sha256")
                .update(`${planDigest}:${i}`)
                .digest("hex"),
              fenceToken: unitClaim.unit.fence_token ?? undefined,
              creatorRole: "aggregation-media-executor",
            },
            signal,
          );
          const mp4Url = mp4Upload.url;
          const renditions: MediaRendition[] = [
            {
              type: "mp4",
              url: mp4Url,
              has_video: mediaInfo.hasVideo,
              mime_type: "video/mp4",
              is_primary: false,
            },
          ];

          let primaryUrl = mp4Url;
          let primaryType = "mp4";
          let hlsUploadManifestIds: string[] = [];
          try {
            const hlsDir = join(localReservation.hlsDir, `chapter_${i}`);
            chapterTempDirs.push(hlsDir);
            tempDirs.push(hlsDir); // final safety net if this chapter throws
            const hls = await createHlsVod(clipPath, hlsDir, undefined, {
              signal,
            });
            const hlsUpload = await uploadHlsDirectory(
              hlsDir,
              unitArtifactPrefix,
              signal,
              {
                tenantId: input.item.tenant_id,
                parentContentItemId: contentItemId,
                atomizationGenerationId: generationResponse.generation.id,
                atomizationChapterUnitId: unitId,
                attemptId: governed?.attemptId,
                inputDigest: createHash("sha256")
                  .update(`${planDigest}:${i}:hls`)
                  .digest("hex"),
                fenceToken: unitClaim.unit.fence_token ?? undefined,
              },
            );
            hlsUploadManifestIds = hlsUpload.manifestIds;
            primaryUrl = hlsUpload.url || mp4Url;
            primaryType = hlsUpload.url ? "hls" : "mp4";
            if (hlsUpload.url) {
              renditions.unshift({
                type: "hls",
                url: hlsUpload.url,
                has_video: mediaInfo.hasVideo,
                mime_type: "application/vnd.apple.mpegurl",
                is_primary: true,
              });
            }
            if (hls.duration > 0) {
              chapter.end_ms =
                chapter.start_ms + Math.round(hls.duration * 1000);
            }
          } catch (hlsError) {
            jobLogger.warn("HLS rendition failed; using MP4 fallback", {
              contentItemId,
              chapter: i,
              error:
                hlsError instanceof Error ? hlsError.message : "Unknown error",
            });
            renditions[0]!.is_primary = true;
          }

          let thumbUrl = input.item.thumbnail_url ?? undefined;
          let thumbManifestId: string | undefined;
          try {
            const thumbPath = join(
              localReservation.outputDir,
              `${contentItemId}_${attemptSuffix}_chapter_${i}.jpg`,
            );
            await extractThumbnail(clipPath, thumbPath, 1, 360, { signal });
            chapterTempFiles.push(thumbPath);
            tempFiles.push(thumbPath); // final safety net if this chapter throws
            const thumbKey = getStorageKey(
              unitArtifactPrefix,
              "thumbnail",
              "jpg",
            );
            const thumbUpload = await uploadFileWithManifest(
              {
                tenantId: input.item.tenant_id,
                parentContentItemId: contentItemId,
                atomizationGenerationId: generationResponse.generation.id,
                atomizationChapterUnitId: unitId,
                attemptId: governed?.attemptId,
                artifactRole: "thumbnail",
                key: thumbKey,
                filePath: thumbPath,
                contentType: "image/jpeg",
                inputDigest: createHash("sha256")
                  .update(`${planDigest}:${i}:thumbnail`)
                  .digest("hex"),
                fenceToken: unitClaim.unit.fence_token ?? undefined,
                creatorRole: "aggregation-media-executor",
              },
              signal,
            );
            thumbUrl = thumbUpload.url;
            thumbManifestId = thumbUpload.manifestId;
          } catch (thumbError) {
            jobLogger.warn("Chapter thumbnail failed; using parent thumbnail", {
              contentItemId,
              chapter: i,
              error:
                thumbError instanceof Error
                  ? thumbError.message
                  : "Unknown error",
            });
          }

          const transcriptSegments = sliceSegments(
            input.segments,
            chapter.start_ms,
            chapter.end_ms,
          );
          children.push({
            ...chapter,
            media_url: mp4Url,
            thumbnail_url: thumbUrl,
            playback_url: primaryUrl,
            playback_type: primaryType,
            fallback_playback_url: mp4Url,
            has_video: mediaInfo.hasVideo,
            media_renditions: renditions,
            transcript_segments: transcriptSegments,
            transcript_text: transcriptSegments
              .map((s) => s.text.trim())
              .filter(Boolean)
              .join(" "),
          });
          await cmsClient.transitionAtomizationChapterUnit(
            unitId,
            "verified",
            {
              claim_token: unitToken,
              result: children[children.length - 1],
              artifact_manifest_ids: [
                mp4Upload.manifestId,
                ...hlsUploadManifestIds,
                ...(thumbManifestId ? [thumbManifestId] : []),
              ],
            },
            job.id,
            signal,
          );
          jobLogger.info("Chapter atomized", {
            contentItemId,
            chapter: i,
            playbackType: primaryType,
            durationSec: cut.duration,
          });
          // Object uploads have completed and the child payload contains only
          // remote URLs. Delete this chapter's working set before advancing.
          await Promise.all(
            chapterTempFiles.map((file) => cleanupTempFile(file)),
          );
          await Promise.all(
            chapterTempDirs.map((dir) =>
              rm(dir, { recursive: true, force: true }),
            ),
          );
        }
        if (governed)
          await cmsClient.checkpointAtomizationWork(
            {
              ...governed,
              phase: "uploads_complete",
              proof: { chapter_count: children.length },
            },
            job.id,
          );

        await report("running", "children", {
          child_count: children.length,
          review_count: countReviewChapters(
            children,
            input.policy.high_confidence_threshold,
          ),
        });
        const result = await cmsClient.finalizeAtomizationGeneration(
          generationResponse.generation.id,
          stageClaim ? contentStageCorrelation(stageClaim) : undefined,
          job.id,
          signal,
        );
        if (stageHeartbeat) {
          clearInterval(stageHeartbeat);
          stageHeartbeat = undefined;
        }
        if (governed)
          await cmsClient.checkpointAtomizationWork(
            {
              ...governed,
              phase: "children_persisted",
              proof: { child_ids: result.children.map((child) => child.id) },
            },
            job.id,
          );
        await enqueueChapterEmbeddingJobs(result.children, children, input);
        if (governed)
          await cmsClient.checkpointAtomizationWork(
            {
              ...governed,
              phase: "embedding_handoff",
              proof: { child_count: result.children.length },
            },
            job.id,
          );
        const reviewCount = countReviewChapters(
          children,
          input.policy.high_confidence_threshold,
        );
        await report(
          reviewCount > 0 ? "needs_review" : "completed",
          "embedding",
          {
            child_count: result.children.length,
            review_count: reviewCount,
          },
        );
        if (governed)
          await cmsClient.checkpointAtomizationWork(
            {
              ...governed,
              phase: "owner_complete",
              proof: {
                child_ids: result.children.map((child) => child.id),
                review_count: reviewCount,
              },
            },
            job.id,
          );
        jobLogger.info("Atomization completed", {
          contentItemId,
          children: result.children.length,
        });
      } finally {
        if (reservationHeartbeat) clearInterval(reservationHeartbeat);
        await localReservation?.release();
        for (const tempFile of tempFiles) {
          await cleanupTempFile(tempFile);
        }
        for (const dir of tempDirs) {
          try {
            await rm(dir, { recursive: true, force: true });
          } catch {
            // ignored
          }
        }
      }
    } catch (error) {
      if (error instanceof ResourceDeferredError && governed) {
        await cmsClient.deferAtomizationWork(
          {
            id: governed.id,
            claimToken: governed.claimToken,
            retryAfterSec: error.retryAfterSec,
            summary: error.message,
          },
          job.id,
        );
        await report("queued", currentPhase, { error_message: error.message });
        return;
      }
      try {
        await report("failed", currentPhase, {
          error_message:
            error instanceof Error ? error.message : "Atomization failed",
        });
      } catch (reportError) {
        jobLogger.warn("Failed to report atomization failure to CMS", {
          contentItemId,
          error:
            reportError instanceof Error
              ? reportError.message
              : "Unknown error",
        });
      }
      throw error;
    } finally {
      if (stageHeartbeat) clearInterval(stageHeartbeat);
    }
  },
});

async function enqueueChapterEmbeddingJobs(
  created: Array<{
    id: string;
    feed_visibility: string;
    delivery_mode: "legacy" | "shadow" | "durable_required";
  }>,
  chapters: AtomizationChapter[],
  input: AtomizationInputResponse,
): Promise<void> {
  const aiQueue = getQueue(QUEUE_NAMES.AI);
  if (!aiQueue) return;
  const compatibilityChildren = compatibilityChapterChildren(created);
  for (const job of buildChapterEmbeddingJobs(
    compatibilityChildren,
    chapters,
    input,
  )) {
    const existing = await aiQueue.getJob(job.options.jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") {
        await existing.remove();
      } else {
        continue;
      }
    }
    await aiQueue.add(job.name, job.data, job.options);
  }
}

interface ResolvedParentMedia {
  url: string;
  extension: string;
  key?: string;
  tier: StorageTier;
}

function storageTierFromInput(input: AtomizationInputResponse): StorageTier {
  return input.item.storage_tier === "cold" ? "cold" : "primary";
}

function keyFromPublicUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const publicRoots = [
    config.storagePublicUrl,
    config.coldStoragePublicUrl,
  ].filter((value): value is string => Boolean(value));
  for (const root of publicRoots) {
    const normalizedRoot = root.replace(/\/$/, "");
    if (url.startsWith(`${normalizedRoot}/`)) {
      return decodeURIComponent(
        url.slice(normalizedRoot.length + 1).split("?")[0] ?? "",
      );
    }
  }
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    const contentIndex = path.indexOf("content/");
    return contentIndex >= 0 ? path.slice(contentIndex) : undefined;
  } catch {
    return undefined;
  }
}

function versionedProcessedKey(contentItemId: string, version: number): string {
  if (version > 1) {
    return `content/${contentItemId}/processed.v${version}.mp4`;
  }
  return getStorageKey(contentItemId, "processed", "mp4");
}

function sourceMediaKeyCandidates(input: AtomizationInputResponse): string[] {
  const keys = [
    keyFromPublicUrl(input.item.media_url),
    keyFromPublicUrl(input.item.playback_url),
    keyFromPublicUrl(input.item.fallback_playback_url),
  ];
  const version = Math.max(1, input.item.media_version ?? 1);
  for (let v = version; v >= 1; v -= 1) {
    keys.push(versionedProcessedKey(input.item.id, v));
  }
  keys.push(getStorageKey(input.item.id, "processed", "mp4"));
  return Array.from(new Set(keys.filter((key): key is string => Boolean(key))));
}

function processedVersionFromKey(key: string): number {
  const match = key.match(/\/processed\.v(\d+)\.[^/]+$/);
  if (!match) return key.includes("/processed.") ? 1 : 0;
  return Number.parseInt(match[1]!, 10) || 0;
}

function fallbackObjectScore(key: string): number {
  if (/\/processed\.v\d+\.(mp4|mov|m4v|webm)$/i.test(key)) {
    return 1000 + processedVersionFromKey(key);
  }
  if (/\/processed\.(mp4|mov|m4v|webm)$/i.test(key)) return 900;
  if (/\/original\.(mp4|mov|m4v|webm)$/i.test(key)) return 700;
  if (/\/audio\.(m4a|mp3|aac|wav|opus)$/i.test(key)) return 500;
  return 0;
}

function extensionFromKeyOrUrl(value: string): string {
  const clean = value.split("?")[0] ?? value;
  const filename = clean.split("/").pop() ?? "";
  const ext = filename.includes(".") ? filename.split(".").pop() : undefined;
  return ext && /^[a-z0-9]+$/i.test(ext) ? ext.toLowerCase() : "mp4";
}

function playbackTypeFromExtension(extension: string): "mp4" | "audio" {
  return ["m4a", "mp3", "aac", "wav", "opus"].includes(extension)
    ? "audio"
    : "mp4";
}

async function resolveParentMediaForAtomization(
  input: AtomizationInputResponse,
  jobLogger: {
    warn: (message: string, data?: Record<string, unknown>) => void;
  },
): Promise<ResolvedParentMedia> {
  const directUrl = input.item.media_url;
  if (!directUrl) {
    throw new Error(`Parent ${input.item.id} has no media_url`);
  }

  const tier = storageTierFromInput(input);
  for (const key of sourceMediaKeyCandidates(input)) {
    if (await objectExists(key, tier)) {
      const url = getPublicUrl(key, tier);
      if (url !== directUrl) {
        jobLogger.warn("Resolved stale parent media URL before atomization", {
          contentItemId: input.item.id,
          storedUrl: directUrl,
          resolvedUrl: url,
          key,
          tier,
        });
        await refreshCmsParentMediaArtifact(input, url, tier, jobLogger);
      }
      return { url, key, tier, extension: extensionFromKeyOrUrl(key) };
    }
  }

  const fallback = (await listContentObjects(input.item.id, tier))
    .map((obj) => obj.Key ?? "")
    .filter(Boolean)
    .map((key) => ({ key, score: fallbackObjectScore(key) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))[0];

  if (fallback) {
    const url = getPublicUrl(fallback.key, tier);
    jobLogger.warn(
      "Resolved parent media URL from storage listing before atomization",
      {
        contentItemId: input.item.id,
        storedUrl: directUrl,
        resolvedUrl: url,
        key: fallback.key,
        tier,
      },
    );
    await refreshCmsParentMediaArtifact(input, url, tier, jobLogger);
    return {
      url,
      key: fallback.key,
      tier,
      extension: extensionFromKeyOrUrl(fallback.key),
    };
  }

  jobLogger.warn(
    "Could not verify parent media in storage before atomization; using CMS media_url",
    {
      contentItemId: input.item.id,
      mediaUrl: directUrl,
      tier,
    },
  );
  return { url: directUrl, tier, extension: extensionFromKeyOrUrl(directUrl) };
}

async function refreshCmsParentMediaArtifact(
  input: AtomizationInputResponse,
  resolvedUrl: string,
  tier: StorageTier,
  jobLogger: {
    warn: (message: string, data?: Record<string, unknown>) => void;
  },
): Promise<void> {
  try {
    await cmsClient.updateArtifacts(input.item.id, {
      media_url: resolvedUrl,
      playback_url: resolvedUrl,
      fallback_playback_url: resolvedUrl,
      playback_type: playbackTypeFromExtension(
        extensionFromKeyOrUrl(resolvedUrl),
      ),
      storage_tier: tier,
    });
  } catch (error) {
    jobLogger.warn(
      "Resolved parent media but failed to refresh CMS artifact URLs",
      {
        contentItemId: input.item.id,
        error: error instanceof Error ? error.message : "Unknown error",
      },
    );
  }
}

async function uploadHlsDirectory(
  dir: string,
  keyPrefix: string,
  signal?: AbortSignal,
  manifestContext?: {
    tenantId: string;
    parentContentItemId: string;
    atomizationGenerationId: string;
    atomizationChapterUnitId: string;
    attemptId?: string;
    inputDigest: string;
    fenceToken?: string;
  },
): Promise<{ url?: string; manifestIds: string[] }> {
  const files = await readdir(dir);
  let playlistUrl: string | undefined;
  const manifestIds: string[] = [];
  const uploadable: Array<{ file: string; path: string; contentType: string }> =
    [];
  for (const file of files) {
    const path = join(dir, file);
    if (!(await stat(path)).isFile()) continue;
    uploadable.push({
      file,
      path,
      contentType: file.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : "video/mp2t",
    });
  }

  for (let i = 0; i < uploadable.length; i += HLS_UPLOAD_CONCURRENCY) {
    const batch = uploadable.slice(i, i + HLS_UPLOAD_CONCURRENCY);
    const urls = await Promise.all(
      batch.map(async (item) => {
        const key = `content/${keyPrefix}/hls/${item.file}`;
        const manifestUpload = manifestContext
          ? await uploadFileWithManifest(
              {
                ...manifestContext,
                artifactRole: "chapter_hls",
                key,
                filePath: item.path,
                contentType: item.contentType,
                creatorRole: "aggregation-media-executor",
              },
              signal,
            )
          : undefined;
        const url =
          manifestUpload?.url ??
          (await uploadFile(
            key,
            item.path,
            item.contentType,
            "primary",
            signal,
          ));
        return { file: item.file, url, manifestId: manifestUpload?.manifestId };
      }),
    );
    for (const item of urls) {
      if (item.file.endsWith(".m3u8")) playlistUrl = item.url;
      if (item.manifestId) manifestIds.push(item.manifestId);
    }
  }
  return { url: playlistUrl, manifestIds };
}
