/**
 * Exact, CMS-fenced Pipeline repair stage execution.
 *
 * This module intentionally does not enqueue MediaJob or AIJob. Those broad
 * jobs own normal ingest and may run several stages; a repair command owns one
 * stage, one attempt and one receipt only.
 */
import { createHash } from 'crypto';
import { join } from 'path';
import { stat } from 'fs/promises';
import type { PipelineRepairStageJob } from '../queues/index.js';
import { downloadHttp, downloadYouTube, cleanupTempFile, isAllowedYouTubeUrl } from '../media/downloader.js';
import { transcodeToMp4, extractThumbnail, getMediaInfo } from '../media/transcoder.js';
import { uploadFile } from '../storage/client.js';
import { config } from '../config/index.js';
import { cmsClient } from '../cms/client.js';
import { generateEmbeddingViaEnrichment } from '../ai/enrichment-client.js';
import { buildEmbeddingText } from '../ai/embeddings.js';
import { resolveIngestProfile } from '../services/quality.service.js';
import { knownDurationAdmissionFailure } from '../services/pods-admission.js';

export interface PipelineRepairEffect {
  outputDigest: string;
  output: Record<string, unknown>;
}

function digest(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireURL(job: PipelineRepairStageJob): string {
  const value = job.content.mediaUrl ?? job.content.originalUrl;
  if (!value) throw new Error('CMS repair command has no approved stage input URL');
  return value;
}

async function download(job: PipelineRepairStageJob, signal?: AbortSignal) {
	return downloadExactURL(job, requireURL(job), signal);
}

async function downloadExactURL(job: PipelineRepairStageJob, sourceUrl: string, signal?: AbortSignal) {
  if (isAllowedYouTubeUrl(sourceUrl)) return downloadYouTube(sourceUrl, `${job.contentItemId}-${job.attemptId}`, signal);
  return downloadHttp(sourceUrl, `${job.contentItemId}-${job.attemptId}`, job.content.type === 'PODCAST' ? 'mp3' : 'mp4', signal);
}

function requireVerifiedArtifact(job: PipelineRepairStageJob, key: string): string {
  const value = job.content.metadata?.[key];
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) {
    throw new Error(`CMS repair command has no verified ${key}`);
  }
  return value;
}

async function mediaDownload(job: PipelineRepairStageJob, signal?: AbortSignal): Promise<PipelineRepairEffect> {
  const source = await download(job, signal);
  try {
    const mediaInfo = await getMediaInfo(source.filePath);
    const durationFailure = knownDurationAdmissionFailure(job.content.type, Math.floor(mediaInfo.duration));
    if (durationFailure) throw new Error(durationFailure);
    const key = `content/${job.contentItemId}/pipeline-repair/${job.attemptId}/original.${source.format || 'bin'}`;
    const url = await uploadFile(key, source.filePath, 'application/octet-stream', 'primary', signal);
    const bytes = await stat(source.filePath).then((entry) => entry.size).catch(() => 0);
    // Keep the downloaded original as non-serving provenance. The item remains
    // in its existing lifecycle state until a later exact transcode repair or
    // normal owner workflow produces verified playback metadata.
    await cmsClient.updateArtifacts(job.contentItemId, { metadata: { pipeline_repair_original_url: url, pipeline_repair_original_digest: digest({ key, bytes, url }) }, expected_item_updated_at: job.itemVersion }, job.deterministicJobId, signal);
    const output = { stage: job.stage, storage_key: key, storage_url: url, bytes };
    return { outputDigest: digest(output), output };
  } finally { await cleanupTempFile(source.filePath); }
}

async function mediaTranscode(job: PipelineRepairStageJob, signal?: AbortSignal): Promise<PipelineRepairEffect> {
  const source = await downloadExactURL(job, requireVerifiedArtifact(job, 'pipeline_repair_original_url'), signal);
  const temp: string[] = [source.filePath];
  try {
    const { profile } = await resolveIngestProfile(job.tenantId, job.content.source);
    const outputPath = join(config.mediaTempDir, `${job.contentItemId}-${job.attemptId}-repair.mp4`);
    temp.push(outputPath);
    const result = await transcodeToMp4(source.filePath, outputPath, profile, { signal });
    const verifiedDurationSec = Math.floor(result.duration);
    const durationFailure = knownDurationAdmissionFailure(job.content.type, verifiedDurationSec);
    if (durationFailure) throw new Error(durationFailure);
    const key = `content/${job.contentItemId}/pipeline-repair/${job.attemptId}/processed.mp4`;
    const url = await uploadFile(key, result.outputPath, 'video/mp4', 'primary', signal);
    const output = { stage: job.stage, storage_key: key, playback_url: url, duration_sec: verifiedDurationSec };
    await cmsClient.updateArtifacts(job.contentItemId, { media_url: url, playback_url: url, playback_type: 'mp4', duration_sec: verifiedDurationSec, metadata: { pipeline_repair_processed_url: url, pipeline_repair_processed_digest: digest({ key, url, duration: verifiedDurationSec }), duration_verification: { source: 'ffprobe', duration_sec: verifiedDurationSec } }, expected_item_updated_at: job.itemVersion }, job.deterministicJobId, signal);
    return { outputDigest: digest(output), output };
  } finally { await Promise.all(temp.map((path) => cleanupTempFile(path))); }
}

async function mediaThumbnail(job: PipelineRepairStageJob, signal?: AbortSignal): Promise<PipelineRepairEffect> {
  const source = await downloadExactURL(job, requireVerifiedArtifact(job, 'pipeline_repair_processed_url'), signal);
  const thumb = join(config.mediaTempDir, `${job.contentItemId}-${job.attemptId}-repair-thumb.jpg`);
  try {
    await extractThumbnail(source.filePath, thumb, 2, 360, { signal });
    const key = `content/${job.contentItemId}/pipeline-repair/${job.attemptId}/thumbnail.jpg`;
    const url = await uploadFile(key, thumb, 'image/jpeg', 'primary', signal);
    const output = { stage: job.stage, storage_key: key, thumbnail_url: url };
    await cmsClient.updateArtifacts(job.contentItemId, { thumbnail_url: url, expected_item_updated_at: job.itemVersion }, job.deterministicJobId, signal);
    return { outputDigest: digest(output), output };
  } finally { await cleanupTempFile(source.filePath); await cleanupTempFile(thumb); }
}

async function textEmbedding(job: PipelineRepairStageJob, signal?: AbortSignal): Promise<PipelineRepairEffect> {
  const text = buildEmbeddingText(job.content.title ?? '', job.content.excerpt, job.content.bodyText);
  if (!text.trim()) throw new Error('CMS repair command has no text for text_embedding');
  const result = await generateEmbeddingViaEnrichment(text, job.contentItemId, {
    requestId: job.deterministicJobId,
    extractTags: job.content.type === 'VIDEO' || job.content.type === 'PODCAST',
    signal,
    pipelineRepair: {
      repair_id: job.repairId,
      attempt_id: job.attemptId,
      claim_token: job.claimToken,
      fence_token: job.fenceToken,
      expected_item_version: job.itemVersion,
      input_digest: job.effectInputDigest,
    },
  });
  if (result.writeBackStatus !== 'ok') throw new Error('Enrichment did not persist the repaired embedding');
  const output = { stage: job.stage, dimensions: result.embedding.length, tags: result.tags?.length ?? 0, write_back: result.writeBackStatus };
  return { outputDigest: digest(output), output };
}

export async function executePipelineRepairStage(job: PipelineRepairStageJob, signal?: AbortSignal): Promise<PipelineRepairEffect> {
  switch (job.stage) {
    case 'media_download': return mediaDownload(job, signal);
    case 'media_transcode': return mediaTranscode(job, signal);
    case 'media_thumbnail': return mediaThumbnail(job, signal);
    case 'text_embedding': return textEmbedding(job, signal);
  }
}
