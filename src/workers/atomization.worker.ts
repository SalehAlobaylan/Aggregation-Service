import { Job } from 'bullmq';
import { join } from 'path';
import { readdir, rm, stat } from 'fs/promises';
import { createWorker } from './base-worker.js';
import { getQueue, QUEUE_NAMES, type AtomizationJob } from '../queues/index.js';
import { cmsClient } from '../cms/client.js';
import { config } from '../config/index.js';
import { downloadHttp, cleanupTempFile } from '../media/downloader.js';
import { createHlsVod, cutMediaSegment, extractThumbnail, getMediaInfo } from '../media/transcoder.js';
import {
    uploadFile,
    getStorageKey,
    getPublicUrl,
    objectExists,
    listContentObjects,
    type StorageTier,
} from '../storage/client.js';
import { generateChaptersViaEnrichment } from '../ai/enrichment-client.js';
import type { AtomizationChapter, AtomizationInputResponse, MediaRendition } from '../cms/types.js';
import {
    buildChapterEmbeddingJobs,
    buildWindows,
    countReviewChapters,
    minFeedUnitSeconds,
    normalizeGeneratedChapters,
    shouldAtomizeParent,
    sliceSegments,
} from './atomization.helpers.js';

const HLS_UPLOAD_CONCURRENCY = 6;

export const atomizationWorker = createWorker({
    queueName: QUEUE_NAMES.ATOMIZATION,
    concurrency: 1,
    timeoutMs: config.mediaJobTimeoutMs,
    processor: async (job: Job<AtomizationJob>, jobLogger): Promise<void> => {
        const { contentItemId } = job.data;
        jobLogger.info('Processing atomization job', { contentItemId, reason: job.data.reason });

        let runId: string | undefined;
        let currentPhase: 'planning' | 'cutting' | 'renditions' | 'children' | 'embedding' = 'planning';
        const report = async (
            status: 'queued' | 'running' | 'completed' | 'needs_review' | 'failed',
            phase: 'planning' | 'cutting' | 'renditions' | 'children' | 'embedding',
            extra: { child_count?: number; review_count?: number; error_message?: string } = {}
        ): Promise<void> => {
            currentPhase = phase;
            const response = await cmsClient.reportAtomizationRun(
                contentItemId,
                { run_id: runId, status, phase, ...extra },
                job.id
            );
            runId = response.run_id;
        };

        try {
            await report('running', 'planning');
            const input = await cmsClient.getAtomizationInput(contentItemId, job.id);
            if (!input.policy.chaptering_enabled) {
                jobLogger.info('Atomization disabled by source policy', { contentItemId });
                await report('completed', 'planning');
                return;
            }
            if (!shouldAtomizeParent(input.item.duration_sec, input.policy.atomization_min_parent_seconds)) {
                jobLogger.info('Atomization skipped because parent is not longer than 40 minutes', {
                    contentItemId,
                    durationSec: input.item.duration_sec,
                });
                await report('completed', 'planning');
                return;
            }
            if (!input.item.media_url) {
                throw new Error(`Parent ${contentItemId} has no media_url`);
            }
            if (!input.transcript || input.segments.length === 0) {
                throw new Error(`Parent ${contentItemId} has no timestamped transcript yet`);
            }

            const windows = buildWindows(input.segments);
            const generated = await generateChaptersViaEnrichment(windows, {
                requestId: job.id,
                language: input.transcript.language,
                maxChapters: input.policy.max_chapters_per_parent,
                minSec: minFeedUnitSeconds(input),
                maxSec: input.policy.hard_max_chapter_minutes * 60,
            });
            const chapters = normalizeGeneratedChapters(generated, windows, input);
            await cmsClient.saveAtomizationPlan(contentItemId, chapters, job.id);
            await report('running', 'cutting');

            const tempFiles: string[] = [];
            const tempDirs: string[] = [];
            try {
                const parentMedia = await resolveParentMediaForAtomization(input, jobLogger);
                const parentDownload = await downloadHttp(parentMedia.url, `${contentItemId}_atomize`, parentMedia.extension);
                tempFiles.push(parentDownload.filePath);
                const mediaInfo = await getMediaInfo(parentDownload.filePath);

                const children: AtomizationChapter[] = [];
                for (let i = 0; i < chapters.length; i += 1) {
                    const chapter = chapters[i]!;
                    const clipPath = join(config.mediaTempDir, `${contentItemId}_chapter_${i}.mp4`);
                    const startSec = chapter.start_ms / 1000;
                    const durationSec = Math.max(1, (chapter.end_ms - chapter.start_ms) / 1000);
                    const cut = await cutMediaSegment(parentDownload.filePath, clipPath, startSec, durationSec);
                    tempFiles.push(clipPath);

                    currentPhase = 'renditions';
                    const mp4Key = getStorageKey(`${contentItemId}/chapters/${i}`, 'processed', 'mp4');
                    const mp4Url = await uploadFile(mp4Key, clipPath, 'video/mp4');
                    const renditions: MediaRendition[] = [{ type: 'mp4', url: mp4Url, mime_type: 'video/mp4', is_primary: false }];

                    let primaryUrl = mp4Url;
                    let primaryType = 'mp4';
                    try {
                        const hlsDir = join(config.mediaTempDir, `${contentItemId}_chapter_${i}_hls`);
                        tempDirs.push(hlsDir);
                        const hls = await createHlsVod(clipPath, hlsDir);
                        const hlsUrl = await uploadHlsDirectory(hlsDir, `${contentItemId}/chapters/${i}`);
                        primaryUrl = hlsUrl || mp4Url;
                        primaryType = hlsUrl ? 'hls' : 'mp4';
                        if (hlsUrl) {
                            renditions.unshift({ type: 'hls', url: hlsUrl, mime_type: 'application/vnd.apple.mpegurl', is_primary: true });
                        }
                        if (hls.duration > 0) {
                            chapter.end_ms = chapter.start_ms + Math.round(hls.duration * 1000);
                        }
                    } catch (hlsError) {
                        jobLogger.warn('HLS rendition failed; using MP4 fallback', {
                            contentItemId,
                            chapter: i,
                            error: hlsError instanceof Error ? hlsError.message : 'Unknown error',
                        });
                        renditions[0]!.is_primary = true;
                    }

                    let thumbUrl = input.item.thumbnail_url ?? undefined;
                    try {
                        const thumbPath = join(config.mediaTempDir, `${contentItemId}_chapter_${i}.jpg`);
                        await extractThumbnail(clipPath, thumbPath, 1, 360);
                        tempFiles.push(thumbPath);
                        const thumbKey = getStorageKey(`${contentItemId}/chapters/${i}`, 'thumbnail', 'jpg');
                        thumbUrl = await uploadFile(thumbKey, thumbPath, 'image/jpeg');
                    } catch (thumbError) {
                        jobLogger.warn('Chapter thumbnail failed; using parent thumbnail', {
                            contentItemId,
                            chapter: i,
                            error: thumbError instanceof Error ? thumbError.message : 'Unknown error',
                        });
                    }

                    const transcriptSegments = sliceSegments(input.segments, chapter.start_ms, chapter.end_ms);
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
                        transcript_text: transcriptSegments.map(s => s.text.trim()).filter(Boolean).join(' '),
                    });
                    jobLogger.info('Chapter atomized', { contentItemId, chapter: i, playbackType: primaryType, durationSec: cut.duration });
                }

                await report('running', 'children', {
                    child_count: children.length,
                    review_count: countReviewChapters(children, input.policy.high_confidence_threshold),
                });
                const result = await cmsClient.createAtomizedChildren(contentItemId, children, job.id);
                await enqueueChapterEmbeddingJobs(result.children, children, input);
                const reviewCount = countReviewChapters(children, input.policy.high_confidence_threshold);
                await report(reviewCount > 0 ? 'needs_review' : 'completed', 'embedding', {
                    child_count: result.children.length,
                    review_count: reviewCount,
                });
                jobLogger.info('Atomization completed', { contentItemId, children: result.children.length });
            } finally {
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
            try {
                await report('failed', currentPhase, {
                    error_message: error instanceof Error ? error.message : 'Atomization failed',
                });
            } catch (reportError) {
                jobLogger.warn('Failed to report atomization failure to CMS', {
                    contentItemId,
                    error: reportError instanceof Error ? reportError.message : 'Unknown error',
                });
            }
            throw error;
        }
    },
});

async function enqueueChapterEmbeddingJobs(
    created: Array<{ id: string; feed_visibility: string }>,
    chapters: AtomizationChapter[],
    input: AtomizationInputResponse
): Promise<void> {
    const aiQueue = getQueue(QUEUE_NAMES.AI);
    if (!aiQueue) return;
    for (const job of buildChapterEmbeddingJobs(created, chapters, input)) {
        const existing = await aiQueue.getJob(job.options.jobId);
        if (existing) {
            const state = await existing.getState();
            if (state === 'completed' || state === 'failed') {
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
    return input.item.storage_tier === 'cold' ? 'cold' : 'primary';
}

function keyFromPublicUrl(url: string | null | undefined): string | undefined {
    if (!url) return undefined;
    const publicRoots = [
        config.storagePublicUrl,
        config.coldStoragePublicUrl,
    ].filter((value): value is string => Boolean(value));
    for (const root of publicRoots) {
        const normalizedRoot = root.replace(/\/$/, '');
        if (url.startsWith(`${normalizedRoot}/`)) {
            return decodeURIComponent(url.slice(normalizedRoot.length + 1).split('?')[0] ?? '');
        }
    }
    try {
        const parsed = new URL(url);
        const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
        const contentIndex = path.indexOf('content/');
        return contentIndex >= 0 ? path.slice(contentIndex) : undefined;
    } catch {
        return undefined;
    }
}

function versionedProcessedKey(contentItemId: string, version: number): string {
    if (version > 1) {
        return `content/${contentItemId}/processed.v${version}.mp4`;
    }
    return getStorageKey(contentItemId, 'processed', 'mp4');
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
    keys.push(getStorageKey(input.item.id, 'processed', 'mp4'));
    return Array.from(new Set(keys.filter((key): key is string => Boolean(key))));
}

function processedVersionFromKey(key: string): number {
    const match = key.match(/\/processed\.v(\d+)\.[^/]+$/);
    if (!match) return key.includes('/processed.') ? 1 : 0;
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
    const clean = value.split('?')[0] ?? value;
    const filename = clean.split('/').pop() ?? '';
    const ext = filename.includes('.') ? filename.split('.').pop() : undefined;
    return ext && /^[a-z0-9]+$/i.test(ext) ? ext.toLowerCase() : 'mp4';
}

function playbackTypeFromExtension(extension: string): 'mp4' | 'audio' {
    return ['m4a', 'mp3', 'aac', 'wav', 'opus'].includes(extension) ? 'audio' : 'mp4';
}

async function resolveParentMediaForAtomization(
    input: AtomizationInputResponse,
    jobLogger: { warn: (message: string, data?: Record<string, unknown>) => void }
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
                jobLogger.warn('Resolved stale parent media URL before atomization', {
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
        .map(obj => obj.Key ?? '')
        .filter(Boolean)
        .map(key => ({ key, score: fallbackObjectScore(key) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))[0];

    if (fallback) {
        const url = getPublicUrl(fallback.key, tier);
        jobLogger.warn('Resolved parent media URL from storage listing before atomization', {
            contentItemId: input.item.id,
            storedUrl: directUrl,
            resolvedUrl: url,
            key: fallback.key,
            tier,
        });
        await refreshCmsParentMediaArtifact(input, url, tier, jobLogger);
        return { url, key: fallback.key, tier, extension: extensionFromKeyOrUrl(fallback.key) };
    }

    jobLogger.warn('Could not verify parent media in storage before atomization; using CMS media_url', {
        contentItemId: input.item.id,
        mediaUrl: directUrl,
        tier,
    });
    return { url: directUrl, tier, extension: extensionFromKeyOrUrl(directUrl) };
}

async function refreshCmsParentMediaArtifact(
    input: AtomizationInputResponse,
    resolvedUrl: string,
    tier: StorageTier,
    jobLogger: { warn: (message: string, data?: Record<string, unknown>) => void }
): Promise<void> {
    try {
        await cmsClient.updateArtifacts(input.item.id, {
            media_url: resolvedUrl,
            playback_url: resolvedUrl,
            fallback_playback_url: resolvedUrl,
            playback_type: playbackTypeFromExtension(extensionFromKeyOrUrl(resolvedUrl)),
            storage_tier: tier,
        });
    } catch (error) {
        jobLogger.warn('Resolved parent media but failed to refresh CMS artifact URLs', {
            contentItemId: input.item.id,
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
}

async function uploadHlsDirectory(dir: string, keyPrefix: string): Promise<string | undefined> {
    const files = await readdir(dir);
    let playlistUrl: string | undefined;
    const uploadable: Array<{ file: string; path: string; contentType: string }> = [];
    for (const file of files) {
        const path = join(dir, file);
        if (!(await stat(path)).isFile()) continue;
        uploadable.push({
            file,
            path,
            contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        });
    }

    for (let i = 0; i < uploadable.length; i += HLS_UPLOAD_CONCURRENCY) {
        const batch = uploadable.slice(i, i + HLS_UPLOAD_CONCURRENCY);
        const urls = await Promise.all(batch.map(async item => {
            const key = `content/${keyPrefix}/hls/${item.file}`;
            const url = await uploadFile(key, item.path, item.contentType);
            return { file: item.file, url };
        }));
        for (const item of urls) {
            if (item.file.endsWith('.m3u8')) playlistUrl = item.url;
        }
    }
    return playlistUrl;
}
