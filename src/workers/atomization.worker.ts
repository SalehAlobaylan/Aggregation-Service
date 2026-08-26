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
  createAdaptiveHlsPackage,
  validateAdaptiveHlsPackage,
  cutMediaSegment,
  extractThumbnail,
  getMediaInfo,
} from "../media/transcoder.js";
import {
  createAndUploadAudioDeliveryLadder,
  preferredAudioRendition,
  type UploadedAudioLadderRendition,
} from "../media/audio-ladder.js";
import {
  uploadFile,
  getStorageKey,
  objectExists,
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
        const parentMedia = await resolveParentMediaForAtomization(input);
        const parentDownload = await downloadHttp(
          parentMedia.url,
          `${contentItemId}_atomize`,
          parentMedia.extension,
          signal,
          localReservation.sourceDir,
        );
        tempFiles.push(parentDownload.filePath);
        const mediaInfo = await getMediaInfo(parentDownload.filePath);
        const deliveryPolicy = (
          await cmsClient.resolveMediaDeliveryPolicy(
            {
              tenant_id: input.item.tenant_id,
              source_type: input.item.source,
              media_kind: mediaInfo.visualAvailable ? "video" : "audio",
              // Podcast episodes and talking-head parents are audio-first by
              // default; only an explicitly HLS-active visual policy spends the
              // ladder cost for a chapter.
              suitability:
                input.item.type === "PODCAST" ? "audio_first_show" : "unknown",
              short_form: true,
            },
            job.id,
            signal,
          )
        ).policy;
        const chapterUsesAdaptiveHls =
          mediaInfo.visualAvailable &&
          deliveryPolicy.primary_mode === "hls" &&
          deliveryPolicy.allow_hls !== false &&
          deliveryPolicy.rollout_state === "active";

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
          const audioOnly = !mediaInfo.visualAvailable;
          const clipPath = join(
            localReservation.outputDir,
            `${contentItemId}_${attemptSuffix}_chapter_${i}.${audioOnly ? "m4a" : "mp4"}`,
          );
          const startSec = chapter.start_ms / 1000;
          const durationSec = Math.max(
            1,
            (chapter.end_ms - chapter.start_ms) / 1000,
          );
          let audioLadder: UploadedAudioLadderRendition[] = [];
          const produceChapterAudioLadder = async () => {
            audioLadder = await withResourceLease(
              "software_encode",
              "required",
              () =>
                createAndUploadAudioDeliveryLadder({
                  tenantId: input.item.tenant_id,
                  parentContentItemId: contentItemId,
                  atomizationGenerationId: generationResponse.generation.id,
                  atomizationChapterUnitId: unitId,
                  attemptId: governed?.attemptId,
                  fenceToken: unitClaim.unit.fence_token ?? undefined,
                  sourcePath: parentDownload.filePath,
                  sourceInfo: mediaInfo,
                  allowSourcePassthrough: false,
                  outputDir: localReservation!.outputDir,
                  outputBaseName: `${contentItemId}-${attemptSuffix}-chapter-${i}-audio`,
                  storagePrefix: `content/${unitArtifactPrefix}`,
                  artifactRole: "delivery_audio",
                  creatorRole: "aggregation-media-executor",
                  inputDigest: createHash("sha256")
                    .update(`${planDigest}:${i}:audio-ladder`)
                    .digest("hex"),
                  startSec,
                  durationSec,
                  signal,
                }),
            );
            for (const audio of audioLadder) {
              if (!audio.localPath) continue;
              chapterTempFiles.push(audio.localPath);
              tempFiles.push(audio.localPath);
            }
          };
          let cut: { outputPath: string; duration: number };
          if (audioOnly) {
            await produceChapterAudioLadder();
            const preferred = preferredAudioRendition(audioLadder);
            cut = {
              outputPath: preferred.localPath!,
              duration: preferred.duration,
            };
          } else {
            cut = await withResourceLease("software_encode", "required", () =>
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
            if (deliveryPolicy.generate_audio_alternate !== false)
              await produceChapterAudioLadder();
          }
          if (governed && i === 0)
            await cmsClient.checkpointAtomizationWork(
              { ...governed, phase: "first_cut", proof: { chapter_index: 0 } },
              job.id,
            );

          currentPhase = "renditions";
          const preferredChapterAudio =
            audioLadder.length > 0
              ? preferredAudioRendition(audioLadder)
              : undefined;
          const mp4Upload = audioOnly
            ? preferredChapterAudio!
            : await uploadFileWithManifest(
                {
                  tenantId: input.item.tenant_id,
                  parentContentItemId: contentItemId,
                  atomizationGenerationId: generationResponse.generation.id,
                  atomizationChapterUnitId: unitId,
                  attemptId: governed?.attemptId,
                  artifactRole: "delivery_progressive",
                  key: getStorageKey(unitArtifactPrefix, "processed", "mp4"),
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
          const renditions: MediaRendition[] = audioOnly
            ? audioLadder.map((audio) => ({
                schema_version: 2,
                id: createHash("sha256")
                  .update(
                    `${generationResponse.generation.id}:${unitId}:audio:${audio.tier}:${audio.manifestId}`,
                  )
                  .digest("hex"),
                role: "native_audio",
                type: "audio",
                url: audio.url,
                has_video: false,
                mime_type: audio.mimeType,
                container: audio.container,
                codec: audio.codec,
                codecs: audio.codec === "aac" ? "mp4a.40.2" : audio.codec,
                quality_tier: audio.tier,
                bitrate_kbps: audio.bitrateKbps,
                manifest_id: audio.manifestId,
                is_primary:
                  audio.manifestId === preferredChapterAudio?.manifestId,
              }))
            : [
                {
                  type: "mp4",
                  url: mp4Url,
                  has_video: true,
                  mime_type: "video/mp4",
                  quality_tier: "standard",
                  manifest_id: mp4Upload.manifestId,
                  is_primary: false,
                },
                ...audioLadder.map((audio) => ({
                  schema_version: 2,
                  id: createHash("sha256")
                    .update(
                      `${generationResponse.generation.id}:${unitId}:audio:${audio.tier}:${audio.manifestId}`,
                    )
                    .digest("hex"),
                  role: "native_audio",
                  type: "audio",
                  url: audio.url,
                  has_video: false,
                  mime_type: audio.mimeType,
                  container: audio.container,
                  codec: audio.codec,
                  codecs: audio.codec === "aac" ? "mp4a.40.2" : audio.codec,
                  quality_tier: audio.tier,
                  bitrate_kbps: audio.bitrateKbps,
                  manifest_id: audio.manifestId,
                  is_primary: false,
                })),
              ];

          let primaryUrl = mp4Url;
          let primaryType = audioOnly ? "audio" : "mp4";
          let hlsUploadManifestIds: string[] = [];
          try {
            if (audioOnly) {
              // The preferred Standard-or-lower native-audio rendition was
              // marked above. Do not also promote the first (Data Saver) tier.
            } else if (chapterUsesAdaptiveHls) {
              const hlsDir = join(localReservation.hlsDir, `chapter_${i}`);
              chapterTempDirs.push(hlsDir);
              tempDirs.push(hlsDir); // final safety net if this chapter throws
              const hls = await withResourceLease(
                "media_io_package",
                "required",
                () => createAdaptiveHlsPackage(clipPath, hlsDir, { signal }),
              );
              const validation = await withResourceLease(
                "media_io_package",
                "required",
                () => validateAdaptiveHlsPackage(hlsDir),
              );
              const hlsUpload = await withResourceLease(
                "media_io_package",
                "required",
                () =>
                  uploadHlsDirectory(hlsDir, unitArtifactPrefix, signal, {
                    tenantId: input.item.tenant_id,
                    parentContentItemId: contentItemId,
                    atomizationGenerationId: generationResponse.generation.id,
                    atomizationChapterUnitId: unitId,
                    attemptId: governed?.attemptId,
                    inputDigest: createHash("sha256")
                      .update(`${planDigest}:${i}:hls`)
                      .digest("hex"),
                    fenceToken: unitClaim.unit.fence_token ?? undefined,
                  }),
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
                  validation_evidence: validation.evidence,
                  is_primary: true,
                });
              }
              if (hls.duration > 0) {
                chapter.end_ms =
                  chapter.start_ms + Math.round(hls.duration * 1000);
              }
            } else {
              renditions[0]!.is_primary = true;
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
            await extractThumbnail(cut.outputPath, thumbPath, 1, 360, {
              signal,
            });
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
            has_video: !audioOnly,
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
                ...new Set([
                  mp4Upload.manifestId,
                  ...audioLadder.map((audio) => audio.manifestId),
                  ...hlsUploadManifestIds,
                  ...(thumbManifestId ? [thumbManifestId] : []),
                ]),
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
  return input.item.source_manifest_storage_tier === "cold"
    ? "cold"
    : "primary";
}

function extensionFromKeyOrUrl(value: string): string {
  const clean = value.split("?")[0] ?? value;
  const filename = clean.split("/").pop() ?? "";
  const ext = filename.includes(".") ? filename.split(".").pop() : undefined;
  return ext && /^[a-z0-9]+$/i.test(ext) ? ext.toLowerCase() : "mp4";
}

async function resolveParentMediaForAtomization(
  input: AtomizationInputResponse,
): Promise<ResolvedParentMedia> {
  const directUrl = input.item.source_manifest_url;
  const manifestKey = input.item.source_manifest_key;
  if (!directUrl || !manifestKey || !input.item.source_manifest_id) {
    throw new Error(`Parent ${input.item.id} has no verified source manifest`);
  }

  const tier = storageTierFromInput(input);
  if (await objectExists(manifestKey, tier)) {
    return {
      url: directUrl,
      key: manifestKey,
      tier,
      extension: extensionFromKeyOrUrl(manifestKey),
    };
  }

  throw new Error(
    `Verified source manifest object is unavailable for ${input.item.id}`,
  );
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
  const uploadable: Array<{
    file: string;
    path: string;
    contentType: string;
    cacheControl: string;
  }> = [];
  for (const file of files) {
    // The progressive fallback is uploaded as its own rendition, never as an
    // HLS segment. (The current chapter MP4 remains the compatibility
    // fallback while old active generations coexist.)
    if (file === "fallback.mp4") continue;
    const path = join(dir, file);
    if (!(await stat(path)).isFile()) continue;
    uploadable.push({
      file,
      path,
      contentType: file.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : file.endsWith(".m4s")
          ? "video/iso.segment"
          : file.endsWith("_init.mp4")
            ? "video/mp4"
            : "application/octet-stream",
      cacheControl: file.endsWith(".m3u8")
        ? "no-cache, max-age=0, must-revalidate"
        : "public, max-age=31536000, immutable",
    });
  }

  // The master is the package identity. Upload and verify it first, then bind
  // every owned playlist/init/segment manifest to that immutable identity.
  uploadable.sort(
    (left, right) =>
      Number(right.file === "master.m3u8") -
      Number(left.file === "master.m3u8"),
  );
  let packageManifestId: string | undefined;
  for (let i = 0; i < uploadable.length;) {
    // Keep the package root out of the concurrent first batch so children
    // cannot be persisted with a missing package_manifest_id.
    const size =
      i === 0 && uploadable[0]?.file === "master.m3u8"
        ? 1
        : HLS_UPLOAD_CONCURRENCY;
    const batch = uploadable.slice(i, i + size);
    const urls = await Promise.all(
      batch.map(async (item) => {
        const key = `content/${keyPrefix}/hls/${item.file}`;
        const manifestUpload = manifestContext
          ? await uploadFileWithManifest(
              {
                ...manifestContext,
                artifactRole:
                  item.file === "master.m3u8"
                    ? "hls_master"
                    : item.file.endsWith(".m3u8")
                      ? "hls_playlist"
                      : item.file.endsWith("_init.mp4")
                        ? "hls_init"
                        : "hls_segment",
                packageManifestId:
                  item.file === "master.m3u8" ? undefined : packageManifestId,
                key,
                filePath: item.path,
                contentType: item.contentType,
                cacheControl: item.cacheControl,
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
            item.cacheControl,
          ));
        return { file: item.file, url, manifestId: manifestUpload?.manifestId };
      }),
    );
    for (const item of urls) {
      if (item.file === "master.m3u8") playlistUrl = item.url;
      if (item.manifestId) {
        manifestIds.push(item.manifestId);
        if (item.file === "master.m3u8") packageManifestId = item.manifestId;
      }
    }
    i += size;
  }
  return { url: playlistUrl, manifestIds };
}
