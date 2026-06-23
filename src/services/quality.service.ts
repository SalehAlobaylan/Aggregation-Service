/**
 * Quality Management — orchestration helpers used by the quality worker, the
 * sweeper worker, and the admin HTTP handlers.
 *
 * The actual S3 + ffmpeg work lives here; the worker is a thin BullMQ wrapper
 * so the same code path can be exercised by manual one-shot HTTP calls during
 * dev / debugging.
 */
import { join } from 'path';
import { mkdir, stat } from 'fs/promises';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { cmsClient } from '../cms/client.js';
import type { QualityProfile } from '../cms/types.js';
import {
    deleteObjectsByKeys,
    getObjectStream,
    listContentObjects,
    getStorageKey,
    getPublicUrl,
    objectExists,
    type StorageTier,
} from '../storage/client.js';
import { uploadFile } from '../storage/client.js';
import {
    DEFAULT_ENCODE_PROFILE,
    type EncodeProfile,
    getMediaInfo,
    transcodeToMp4,
} from '../media/transcoder.js';
import { cleanupTempFile } from '../media/downloader.js';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

/**
 * Convert a CMS QualityProfile row into the EncodeProfile shape ffmpeg uses.
 */
export function toEncodeProfile(p: QualityProfile): EncodeProfile {
    return {
        videoCodec: p.video_codec,
        maxHeight: p.max_height,
        targetBitrateKbps: p.target_bitrate_kbps,
        crf: p.crf,
        preset: p.preset,
        audioCodec: p.audio_codec,
        audioBitrateKbps: p.audio_bitrate_kbps,
    };
}

async function ensureTempDir(): Promise<string> {
    await mkdir(config.mediaTempDir, { recursive: true });
    return config.mediaTempDir;
}

/**
 * Stream a remote S3 object onto local disk so ffmpeg can read it. Returns the
 * absolute temp path. Caller is responsible for cleanup via cleanupTempFile.
 */
async function downloadToTemp(
    contentItemId: string,
    sourceKey: string,
    tier: StorageTier
): Promise<{ path: string; size: number; contentType?: string }> {
    await ensureTempDir();
    const tempPath = join(config.mediaTempDir, `qre-${contentItemId}.in.mp4`);
    const src = await getObjectStream(sourceKey, tier);
    await pipeline(src.body, createWriteStream(tempPath));
    const st = await stat(tempPath);
    return { path: tempPath, size: st.size, contentType: src.contentType };
}

export interface ReencodeResult {
    success: boolean;
    mediaUrl?: string;
    newSizeBytes: number;
    newBitrateKbps: number;
    originalSizeBytes: number;
    originalBitrateKbps: number;
    durationMs: number;
    oldKey?: string;
    newKey?: string;
    /** Storage tier the new key was written to. Cleanup of the old key must use the same tier. */
    tier: StorageTier;
    error?: string;
    /** True when the item was already at the target profile and ffmpeg was skipped. */
    skippedIdempotent?: boolean;
    /** True when retrying would repeat the same deterministic failure. */
    nonRetryable?: boolean;
    /** True when CMS points at media that no longer exists in object storage. */
    skippedMissingSource?: boolean;
    /** Source keys considered before the worker gave up or found a fallback. */
    sourceCandidates?: string[];
}

/**
 * Strip the configured public URL prefix from a media URL to recover the
 * underlying S3 key. Returns null if the URL is not on either of the
 * configured tier prefixes (e.g. a CDN-fronted URL we don't control, or a
 * legacy URL from before this prefix existed).
 *
 * Used by the quality worker to figure out which key to download for
 * re-encode — we cannot assume `processed.mp4` once an item has been
 * re-encoded once before (it'll be `processed.v2.mp4`, then v3, ...).
 */
export function keyFromUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const stripPrefix = (u: string, prefix: string | null | undefined): string | null => {
        if (!prefix) return null;
        const normalized = prefix.replace(/\/$/, '');
        if (u.startsWith(normalized + '/')) {
            return u.slice(normalized.length + 1);
        }
        return null;
    };
    return (
        stripPrefix(url, config.storagePublicUrl) ??
        stripPrefix(url, config.coldStoragePublicUrl) ??
        null
    );
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

/**
 * Build deterministic source-key candidates before falling back to an S3 prefix
 * listing. The live media_url wins because it tracks prior re-encode versions;
 * historical rows may still only have the legacy processed.mp4 key.
 */
export function sourceKeyCandidates(
    contentItemId: string,
    mediaUrl: string | null | undefined,
    mediaVersion: number | null | undefined
): string[] {
    const version = Math.max(1, mediaVersion ?? 1);
    const versioned: string[] = [];
    for (let v = version; v >= 1; v--) {
        versioned.push(versionedKey(contentItemId, v));
    }
    return uniqueStrings([
        keyFromUrl(mediaUrl),
        ...versioned,
        getStorageKey(contentItemId, 'processed', 'mp4'),
    ]);
}

function versionFromProcessedKey(key: string): number {
    const file = key.split('/').pop() ?? '';
    const match = /^processed\.v(\d+)\./.exec(file);
    if (match) return Number(match[1]);
    if (file.startsWith('processed.')) return 1;
    return 0;
}

function fallbackObjectScore(key: string): number {
    const file = key.split('/').pop() ?? '';
    if (/^processed(\.v\d+)?\./.test(file)) {
        return 3000 + versionFromProcessedKey(key);
    }
    if (/^original\./.test(file)) return 2000;
    if (/^audio\./.test(file)) return 1000;
    return 0;
}

async function resolveSourceKey(
    contentItemId: string,
    mediaUrl: string | null | undefined,
    mediaVersion: number | null | undefined,
    tier: StorageTier
): Promise<{ key: string | null; candidates: string[]; usedListedFallback: boolean }> {
    const candidates = sourceKeyCandidates(contentItemId, mediaUrl, mediaVersion);
    for (const key of candidates) {
        if (await objectExists(key, tier)) {
            return { key, candidates, usedListedFallback: false };
        }
    }

    const listed = await listContentObjects(contentItemId, tier);
    const fallbackKeys = listed
        .map(obj => obj.Key)
        .filter((key): key is string => Boolean(key))
        .filter(key => fallbackObjectScore(key) > 0)
        .sort((a, b) => fallbackObjectScore(b) - fallbackObjectScore(a));

    const allCandidates = uniqueStrings([...candidates, ...fallbackKeys]);
    return {
        key: fallbackKeys[0] ?? null,
        candidates: allCandidates,
        usedListedFallback: Boolean(fallbackKeys[0]),
    };
}

function nonRetryableResult(
    result: ReencodeResult,
    error: string,
    start: number,
    extra?: Partial<ReencodeResult>
): ReencodeResult {
    result.error = error;
    result.durationMs = Date.now() - start;
    result.nonRetryable = true;
    Object.assign(result, extra);
    return result;
}

function isStorageMissingError(err: unknown): boolean {
    const anyErr = err as { name?: string; code?: string; $metadata?: { httpStatusCode?: number }; message?: string };
    const text = `${anyErr?.name ?? ''} ${anyErr?.code ?? ''} ${anyErr?.message ?? ''}`.toLowerCase();
    return (
        anyErr?.$metadata?.httpStatusCode === 404 ||
        text.includes('nosuchkey') ||
        text.includes('notfound') ||
        text.includes('specified key does not exist')
    );
}

async function markMissingSourceFailed(
    contentItemId: string,
    candidates: string[] | undefined
): Promise<void> {
    try {
        await cmsClient.updateStatus(contentItemId, {
            status: 'FAILED',
            failure_reason: 'quality_reencode_source_object_missing',
        });
        logger.warn('Quality re-encode marked content FAILED because source object is missing', {
            contentItemId,
            candidates,
        });
    } catch (err) {
        logger.error('Quality re-encode could not mark missing-source content FAILED', err, {
            contentItemId,
            candidates,
        });
    }
}

/**
 * Re-encode one content item to a target profile. End-to-end:
 *   1. Resolve the item's current media key + tier from CMS.
 *   2. Download the source object to a temp path.
 *   3. ffprobe → capture original bitrate/size.
 *   4. ffmpeg into the target profile, write to a fresh temp path.
 *   5. Upload to a versioned key (`processed.v{N+1}.mp4`) on the same tier.
 *   6. Patch CMS (URL swap + new size + bitrate + profile id + bump version).
 *   7. Schedule the prior key for grace-period deletion via the cleanup queue.
 *
 * Retryable errors short-circuit without mutating S3 or DB. Confirmed missing
 * source objects are terminal: the item is marked FAILED in CMS so it stops
 * being served/enqueued as if its media were still healthy.
 */
export async function reencodeOneItem(args: {
    contentItemId: string;
    targetProfileId: number;
    tenantId: string;
    ruleId?: number;
    trigger: 'manual' | 'rule' | 'ingest';
}): Promise<ReencodeResult> {
    const start = Date.now();
    const { contentItemId, targetProfileId, tenantId, ruleId, trigger } = args;
    // tenantId / ruleId are kept on the args for compatibility with the
    // BullMQ job payload shape (storage sweeps fill them in for telemetry),
    // but the per-history-row writes that consumed them were dropped in
    // Phase 7 — sweep accounting now lives on storage_sweep_runs instead.
    void tenantId;
    void ruleId;
    void trigger;

    const result: ReencodeResult = {
        success: false,
        newSizeBytes: 0,
        newBitrateKbps: 0,
        originalSizeBytes: 0,
        originalBitrateKbps: 0,
        durationMs: 0,
        tier: 'primary',
    };

    let tempIn: string | undefined;
    let tempOut: string | undefined;

    try {
        // 1. Pull the item record first — we need its source_type for the
        // "auto" profile-resolution path AND its tier/version/URL regardless
        // of which path we take.
        const item = await cmsClient.getContentItem(contentItemId);

        // Resolve the profile. Storage sweeps pass targetProfileId=0 to mean
        // "auto-pick the resolved ingest profile for this item" (the
        // re_encode_target_profile_id field on StoragePolicy was null).
        // Manual triggers pass a concrete id directly.
        let profile: import('../cms/types.js').QualityProfile;
        if (targetProfileId > 0) {
            profile = await cmsClient.getQualityProfile(targetProfileId);
        } else {
            // Auto-resolve: pick the most-specific profile for this item's
            // (tenant, source) tuple. CMS guarantees source_type is set
            // (empty string when unknown) so the resolver always gets a value.
            const sourceFromItem = item.source_type || undefined;
            const resolved = await resolveIngestProfile(item.tenant_id, sourceFromItem);
            if (!resolved.rawProfile) {
                throw new Error('re_encode: no profile available (CMS has no global default and no explicit target)');
            }
            profile = resolved.rawProfile;
        }

        // Idempotency: if the item is already at this profile, skip ffmpeg.
        if (item.current_quality_profile_id === profile.id) {
            logger.info('Quality re-encode skipped — already at target profile', {
                contentItemId,
                targetProfileId: profile.id,
            });
            result.success = true;
            result.skippedIdempotent = true;
            result.originalSizeBytes = item.file_size_bytes;
            result.originalBitrateKbps = item.current_bitrate_kbps ?? 0;
            result.newSizeBytes = item.file_size_bytes;
            result.newBitrateKbps = result.originalBitrateKbps;
            result.durationMs = Date.now() - start;
            return result;
        }

        const tier: StorageTier = item.storage_tier === 'cold' ? 'cold' : 'primary';
        result.tier = tier;

        const source = await resolveSourceKey(
            contentItemId,
            item.media_url,
            item.media_version,
            tier
        );
        result.sourceCandidates = source.candidates;
        if (!source.key) {
            logger.warn('Quality re-encode skipped — source object missing', {
                contentItemId,
                tier,
                mediaUrl: item.media_url,
                candidates: source.candidates,
            });
            await markMissingSourceFailed(contentItemId, source.candidates);
            return nonRetryableResult(
                result,
                'source_object_missing',
                start,
                { skippedMissingSource: true }
            );
        }
        if (source.usedListedFallback) {
            logger.warn('Quality re-encode using listed storage fallback', {
                contentItemId,
                tier,
                selectedKey: source.key,
                candidates: source.candidates,
            });
        }
        const sourceKey = source.key;

        // 2. Download.
        const downloaded = await downloadToTemp(contentItemId, sourceKey, tier);
        tempIn = downloaded.path;
        result.originalSizeBytes = downloaded.size;

        const preflightBeforeProbe = preflightCheck(
            { mimeType: downloaded.contentType, sizeBytes: downloaded.size },
            profile
        );
        if (preflightBeforeProbe) {
            logger.warn('Quality re-encode skipped — input failed preflight', {
                contentItemId,
                sourceKey,
                reason: preflightBeforeProbe,
            });
            return nonRetryableResult(result, preflightBeforeProbe, start, { oldKey: sourceKey });
        }

        // 3. Probe.
        const info = await getMediaInfo(tempIn);
        if (info.bitrateKbps) result.originalBitrateKbps = info.bitrateKbps;

        const preflightAfterProbe = preflightCheck(
            {
                mimeType: downloaded.contentType,
                sizeBytes: downloaded.size,
                durationSec: info.duration,
            },
            profile
        );
        if (preflightAfterProbe) {
            logger.warn('Quality re-encode skipped — probed input failed preflight', {
                contentItemId,
                sourceKey,
                reason: preflightAfterProbe,
            });
            return nonRetryableResult(result, preflightAfterProbe, start, { oldKey: sourceKey });
        }

        // 4. Encode.
        await ensureTempDir();
        tempOut = join(config.mediaTempDir, `qre-${contentItemId}.out.mp4`);
        const encodeProfile = toEncodeProfile(profile);
        await transcodeToMp4(tempIn, tempOut, encodeProfile);

        const outStat = await stat(tempOut);
        result.newSizeBytes = outStat.size;
        const outInfo = await getMediaInfo(tempOut).catch(() => null);
        if (outInfo?.bitrateKbps) result.newBitrateKbps = outInfo.bitrateKbps;

        // 5. Upload to the next versioned key on the same tier. Versioning
        // avoids CDN cache poisoning and lets us delete the prior key after a
        // grace window. The version counter is read from the DB (media_version)
        // — no in-memory cache, so concurrent workers and restarts are safe.
        const newVersion = item.media_version + 1;
        const newKey = versionedKey(contentItemId, newVersion);
        await uploadFile(newKey, tempOut, 'video/mp4', tier);
        result.newKey = newKey;
        result.oldKey = sourceKey;

        // 6. Patch CMS — bump_version increments media_version atomically
        // server-side, so the next worker call to getContentItem sees N+1.
        const newUrl = getPublicUrl(newKey, tier);
        const patch = await cmsClient.updateContentItemQuality(contentItemId, {
            media_url: newUrl,
            file_size_bytes: result.newSizeBytes,
            current_bitrate_kbps: result.newBitrateKbps || result.originalBitrateKbps,
            current_quality_profile_id: profile.id,
            bump_version: true,
        });
        result.mediaUrl = newUrl;
        logger.info('Quality re-encode patched CMS', {
            contentItemId,
            tier,
            oldKey: sourceKey,
            newKey,
            mediaVersion: patch.media_version,
        });

        // 7. Mark success. Re-encode history is now folded into the storage
        // sweep-run row (storage_sweep_runs.re_encoded_count + freed_bytes)
        // since Storage is the orchestrator that requested this work.
        result.durationMs = Date.now() - start;
        result.success = true;

        return result;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isStorageMissingError(err)) {
            await markMissingSourceFailed(contentItemId, result.sourceCandidates);
            return nonRetryableResult(
                result,
                'source_object_missing',
                start,
                { skippedMissingSource: true }
            );
        }
        result.error = msg;
        result.durationMs = Date.now() - start;
        logger.error('Quality re-encode failed', err, { contentItemId, targetProfileId });
        // Failure is reported back to the BullMQ worker via the error in the
        // result object; storage.service consumes it when updating the sweep
        // run row. We don't write a separate history table any more.
        return result;
    } finally {
        if (tempIn) await cleanupTempFile(tempIn).catch(() => undefined);
        if (tempOut) await cleanupTempFile(tempOut).catch(() => undefined);
    }
}

// =============================================================================
// Versioned key helpers
// =============================================================================

/**
 * Build the versioned key for a re-encoded artifact. v1 is the historical
 * unversioned key (`content/{id}/processed.mp4`); v2+ get a `.v{N}` suffix.
 */
export function versionedKey(contentItemId: string, version: number): string {
    if (version <= 1) {
        return getStorageKey(contentItemId, 'processed', 'mp4');
    }
    return `content/${contentItemId}/processed.v${version}.mp4`;
}

/**
 * Delete a key on the given tier. Used by the cleanup queue after the grace
 * period to drop the pre-re-encode artifact. The tier MUST match the tier the
 * new versioned key was written to — otherwise we risk deleting an unrelated
 * object on the wrong bucket (or no-op'ing when we should clean up cold).
 */
export async function deleteOldVersion(key: string, tier: StorageTier): Promise<void> {
    const r = await deleteObjectsByKeys([key], tier);
    if (r.errors.length > 0) {
        logger.warn('Quality cleanup: delete had errors', { errors: r.errors });
    }
}

// =============================================================================
// Probe helper used by the admin endpoint
// =============================================================================

export interface ProbeOutcome {
    duration: number;
    width?: number;
    height?: number;
    bitrate_kbps?: number;
    video_codec?: string;
    audio_codec?: string;
}

export async function probeContentItem(
    contentItemId: string,
    tier: StorageTier
): Promise<ProbeOutcome> {
    const key = getStorageKey(contentItemId, 'processed', 'mp4');
    const tempPath = join(config.mediaTempDir, `qprobe-${contentItemId}.mp4`);
    let cleanedUp = false;
    try {
        await ensureTempDir();
        const src = await getObjectStream(key, tier);
        await pipeline(src.body, createWriteStream(tempPath));
        const info = await getMediaInfo(tempPath);
        return {
            duration: info.duration,
            width: info.width,
            height: info.height,
            bitrate_kbps: info.bitrateKbps,
            video_codec: info.videoCodec,
            audio_codec: info.audioCodec,
        };
    } finally {
        if (!cleanedUp) {
            cleanedUp = true;
            await cleanupTempFile(tempPath).catch(() => undefined);
        }
    }
}

// =============================================================================
// Ingest profile resolution
//
// Phase 7: replaces the old "single global default" lookup with a scoped
// resolver that picks the most-specific profile for (tenant, source_type).
// Cached per-(tenant, sourceType) tuple for 60s to keep the ingest hot path
// from hitting CMS on every job.
// =============================================================================

interface CachedResolution {
    profile: EncodeProfile;
    profileId: number | null;
    rawProfile: import('../cms/types.js').QualityProfile | null;
    expiresAt: number;
}
const ingestResolveCache = new Map<string, CachedResolution>();
const RESOLVE_TTL_MS = 60_000;

function resolveCacheKey(tenantId: string | undefined, sourceType: string | undefined): string {
    return `${tenantId ?? ''}|${sourceType ?? ''}`;
}

/**
 * Resolve the operator-configured ingest profile for the given (tenant,
 * sourceType) combination. Falls back to DEFAULT_ENCODE_PROFILE when CMS has
 * no matching profile or is unreachable.
 *
 * Returns the EncodeProfile (for ffmpeg) AND the raw CMS profile (for
 * pre-flight checks like MIME whitelist / size / duration limits).
 */
export async function resolveIngestProfile(
    tenantId?: string,
    sourceType?: string
): Promise<{
    profile: EncodeProfile;
    profileId: number | null;
    rawProfile: import('../cms/types.js').QualityProfile | null;
}> {
    const now = Date.now();
    const key = resolveCacheKey(tenantId, sourceType);
    const cached = ingestResolveCache.get(key);
    if (cached && cached.expiresAt > now) {
        return {
            profile: cached.profile,
            profileId: cached.profileId,
            rawProfile: cached.rawProfile,
        };
    }
    try {
        const resp = await cmsClient.resolveQualityProfile({
            tenant_id: tenantId,
            source_type: sourceType,
        });
        const profile = resp ? toEncodeProfile(resp.profile) : DEFAULT_ENCODE_PROFILE;
        const out = {
            profile,
            profileId: resp?.profile.id ?? null,
            rawProfile: resp?.profile ?? null,
        };
        ingestResolveCache.set(key, { ...out, expiresAt: now + RESOLVE_TTL_MS });
        return out;
    } catch (err) {
        logger.warn('resolveIngestProfile: CMS lookup failed; using built-in default', { err, tenantId, sourceType });
        const out = { profile: DEFAULT_ENCODE_PROFILE, profileId: null, rawProfile: null };
        ingestResolveCache.set(key, { ...out, expiresAt: now + RESOLVE_TTL_MS });
        return out;
    }
}

/** Test-only — flush the cache so resolution starts fresh. */
export function _resetIngestResolveCacheForTest(): void {
    ingestResolveCache.clear();
}

// =============================================================================
// Pre-flight checks — applied before any download / transcode work runs.
// Returns null when the input is acceptable, or a string failure_reason when
// it should be rejected.
// =============================================================================

export interface PreflightInput {
    mimeType?: string | null;
    sizeBytes?: number | null;
    durationSec?: number | null;
}

export function preflightCheck(
    input: PreflightInput,
    rawProfile: import('../cms/types.js').QualityProfile | null
): string | null {
    if (!rawProfile) return null;

    const allowed = rawProfile.allowed_input_mime_types;
    if (allowed && allowed.length > 0 && input.mimeType) {
        const got = input.mimeType.toLowerCase();
        const ok = allowed.some(t => t.toLowerCase() === got);
        if (!ok) {
            return `disallowed_input_mime: got ${got}, allowed=[${allowed.join(',')}]`;
        }
    }
    if (rawProfile.max_input_size_bytes && input.sizeBytes && input.sizeBytes > rawProfile.max_input_size_bytes) {
        return `input_too_large: ${input.sizeBytes} > ${rawProfile.max_input_size_bytes}`;
    }
    if (rawProfile.max_input_duration_sec && input.durationSec && input.durationSec > rawProfile.max_input_duration_sec) {
        return `input_too_long: ${input.durationSec}s > ${rawProfile.max_input_duration_sec}s`;
    }
    return null;
}
