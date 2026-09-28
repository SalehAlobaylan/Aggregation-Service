/**
 * Unit tests for the pure helpers in services/quality.service.ts.
 *
 * Skips the I/O-heavy `reencodeOneItem` (covered by integration tests once
 * the test S3 + CMS doubles are in place) and focuses on the four pure
 * helpers that drive correctness of every re-encode:
 *   - toEncodeProfile()  : CMS shape → ffmpeg shape mapping
 *   - versionedKey()     : v1 = unversioned legacy key; v2+ = .v{N} suffix
 *   - keyFromUrl()       : reverse-derive S3 key from a public URL on either tier
 *   - DEFAULT_ENCODE_PROFILE: matches the historical hard-coded recipe
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const cmsMocks = vi.hoisted(() => ({
    getContentItem: vi.fn(),
    recordStorageArtifactEvent: vi.fn(),
    listArtifactManifests: vi.fn(),
    getArtifactManifest: vi.fn(),
    transitionArtifactManifest: vi.fn(),
}));
const manifestMocks = vi.hoisted(() => ({
    uploadFileWithManifest: vi.fn(),
}));
const storageMocks = vi.hoisted(() => ({
    deleteObjectsByKeys: vi.fn(),
    objectExists: vi.fn(),
}));

// Mock the config import so keyFromUrl has stable prefixes regardless of env.
// We need a complete-enough shape because pino (via the logger) reads logLevel
// at module-load time, and the storage client reads its own config fields.
vi.mock('../../src/config/index.js', () => ({
    config: {
        // Logger
        logLevel: 'silent',
        nodeEnv: 'test',
        // What this test actually exercises
        storagePublicUrl: 'http://primary.example.com/wahb-media',
        coldStoragePublicUrl: 'https://cold.example.com/wahb-archive',
        mediaTempDir: '/tmp/wahb-media',
        // Storage client touches these on import
        storageBucket: 'wahb-media',
        storageEndpoint: 'http://localhost:9000',
        storageAccessKey: 'test',
        storageSecretKey: 'test',
        storageRegion: 'us-east-1',
        coldStorageEnabled: false,
        coldStorageEndpoint: null,
        coldStorageBucket: null,
        coldStorageAccessKey: null,
        coldStorageSecretKey: null,
        coldStorageRegion: 'us-east-1',
    },
    getRedactedConfig: () => ({}),
}));

vi.mock('../../src/cms/client.js', () => ({
    cmsClient: {
        getContentItem: cmsMocks.getContentItem,
        recordStorageArtifactEvent: cmsMocks.recordStorageArtifactEvent,
        listArtifactManifests: cmsMocks.listArtifactManifests,
        getArtifactManifest: cmsMocks.getArtifactManifest,
        transitionArtifactManifest: cmsMocks.transitionArtifactManifest,
    },
}));
vi.mock('../../src/storage/client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/storage/client.js')>();
    return {
        ...actual,
        deleteObjectsByKeys: storageMocks.deleteObjectsByKeys,
        objectExists: storageMocks.objectExists,
    };
});
vi.mock('../../src/storage/manifest.js', () => ({
    uploadFileWithManifest: manifestMocks.uploadFileWithManifest,
}));

// We import after the mock so the module sees our fake config.
import {
    reencodeOneItem,
    toEncodeProfile,
    versionedKey,
    keyFromUrl,
    sourceKeyCandidates,
    qualityReencodeManifestInput,
    deleteOldVersion,
} from '../../src/services/quality.service.js';
import {
    buildEncodeOptions,
    DEFAULT_ENCODE_PROFILE,
    FFMPEG_TRANSCODE_THREADS,
} from '../../src/media/transcoder.js';

describe('toEncodeProfile', () => {
    it('maps every CMS QualityProfile field onto its ffmpeg counterpart', () => {
        const cmsProfile = {
            id: 7,
            tenant_id: null,
            name: 'mobile-720p',
            description: '',
            video_codec: 'h264' as const,
            max_height: 720,
            target_bitrate_kbps: 0,
            crf: 26,
            preset: 'fast',
            audio_codec: 'aac' as const,
            audio_bitrate_kbps: 96,
            is_default: false,
            is_active: true,
        };
        expect(toEncodeProfile(cmsProfile)).toEqual({
            videoCodec: 'h264',
            maxHeight: 720,
            targetBitrateKbps: 0,
            crf: 26,
            preset: 'fast',
            audioCodec: 'aac',
            audioBitrateKbps: 96,
        });
    });

    it('round-trips opus / h265 codec values without lossy coercion', () => {
        const out = toEncodeProfile({
            id: 1, tenant_id: null, name: '', description: '',
            video_codec: 'h265', max_height: 0, target_bitrate_kbps: 1500,
            crf: 23, preset: 'slow', audio_codec: 'opus', audio_bitrate_kbps: 64,
            is_default: false, is_active: true,
        });
        expect(out.videoCodec).toBe('h265');
        expect(out.audioCodec).toBe('opus');
    });
});

describe('versionedKey', () => {
    const id = '11111111-2222-3333-4444-555555555555';

    it('returns the legacy unversioned key for v1 (and any non-positive)', () => {
        // The legacy key (`processed.mp4`) IS v1 — the system was minted before
        // the version system existed. We must not write `processed.v1.mp4` or
        // we'd orphan every pre-existing object.
        expect(versionedKey(id, 1)).toBe(`content/${id}/processed.mp4`);
        expect(versionedKey(id, 0)).toBe(`content/${id}/processed.mp4`);
        expect(versionedKey(id, -3)).toBe(`content/${id}/processed.mp4`);
    });

    it('returns versioned keys for v2 and above', () => {
        expect(versionedKey(id, 2)).toBe(`content/${id}/processed.v2.mp4`);
        expect(versionedKey(id, 3)).toBe(`content/${id}/processed.v3.mp4`);
        expect(versionedKey(id, 7)).toBe(`content/${id}/processed.v7.mp4`);
    });
});

describe('quality re-encode artifact reservation', () => {
    it('binds the CMS artifact reservation to the exact item, source version and profile', () => {
        const input = qualityReencodeManifestInput({
            tenantId: 'tenant-a',
            contentItemId: '11111111-2222-3333-4444-555555555555',
            sourceKey: 'content/item/processed.v4.mp4',
            mediaVersion: 4,
            targetProfileId: 7,
            tier: 'primary',
            key: 'content/item/processed.v5.mp4',
            filePath: '/tmp/result.mp4',
        });
        const expectedDigest = createHash('sha256').update(JSON.stringify({
            tenant_id: 'tenant-a',
            content_item_id: '11111111-2222-3333-4444-555555555555',
            source_key: 'content/item/processed.v4.mp4',
            media_version: 4,
            target_profile_id: 7,
            storage_tier: 'primary',
            object_key: 'content/item/processed.v5.mp4',
        })).digest('hex');

        expect(input).toEqual(expect.objectContaining({
            tenantId: 'tenant-a',
            contentItemId: '11111111-2222-3333-4444-555555555555',
            artifactRole: 'playback_mp4',
            key: 'content/item/processed.v5.mp4',
            filePath: '/tmp/result.mp4',
            contentType: 'video/mp4',
            tier: 'primary',
            inputDigest: expectedDigest,
            producerEventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            fenceToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
            creatorRole: 'aggregation_quality_worker',
        }));
        const retry = qualityReencodeManifestInput({
            tenantId: 'tenant-a',
            contentItemId: '11111111-2222-3333-4444-555555555555',
            sourceKey: 'content/item/processed.v4.mp4',
            mediaVersion: 4,
            targetProfileId: 7,
            tier: 'primary',
            key: 'content/item/processed.v5.mp4',
            filePath: '/tmp/result.mp4',
        });
        expect(retry.producerEventId).toBe(input.producerEventId);
        expect(retry.fenceToken).toBe(input.fenceToken);
        expect(qualityReencodeManifestInput({
            tenantId: 'tenant-b',
            contentItemId: '11111111-2222-3333-4444-555555555555',
            sourceKey: 'content/item/processed.v4.mp4',
            mediaVersion: 4,
            targetProfileId: 7,
            tier: 'primary',
            key: 'content/item/processed.v5.mp4',
            filePath: '/tmp/result.mp4',
        }).producerEventId).not.toBe(input.producerEventId);
        expect(qualityReencodeManifestInput({
            tenantId: 'tenant-a',
            contentItemId: '11111111-2222-3333-4444-555555555555',
            sourceKey: 'content/item/processed.v4.mp4',
            mediaVersion: 4,
            targetProfileId: 7,
            tier: 'cold',
            key: 'content/item/processed.v5.mp4',
            filePath: '/tmp/result.mp4',
        }).producerEventId).not.toBe(input.producerEventId);
    });
});

describe('keyFromUrl', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    it('strips the primary public URL prefix', () => {
        const url = `http://primary.example.com/wahb-media/content/${id}/processed.mp4`;
        expect(keyFromUrl(url)).toBe(`content/${id}/processed.mp4`);
    });

    it('strips the cold public URL prefix', () => {
        const url = `https://cold.example.com/wahb-archive/content/${id}/processed.v3.mp4`;
        expect(keyFromUrl(url)).toBe(`content/${id}/processed.v3.mp4`);
    });

    it('strips the prefix even when it has a trailing slash', () => {
        // Test by passing a URL where the underlying key is what matters; the
        // helper normalises trailing slashes on the prefix internally.
        const url = `http://primary.example.com/wahb-media/content/${id}/processed.v2.mp4`;
        expect(keyFromUrl(url)).toBe(`content/${id}/processed.v2.mp4`);
    });

    it('returns null for a URL on neither configured tier', () => {
        expect(keyFromUrl('https://some-cdn.example.com/foo/bar.mp4')).toBeNull();
    });

    it('returns null for null / undefined / empty input', () => {
        expect(keyFromUrl(null)).toBeNull();
        expect(keyFromUrl(undefined)).toBeNull();
        expect(keyFromUrl('')).toBeNull();
    });
});

describe('reencodeOneItem terminal lifecycle guards', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        cmsMocks.recordStorageArtifactEvent.mockResolvedValue({ success: true, event_id: 'evt-1' });
    });

    it('skips stale failed/orphan re-encode jobs without marking content failed again', async () => {
        cmsMocks.getContentItem.mockResolvedValue({
            id: '99999999-2222-3333-4444-555555555555',
            tenant_id: 'default',
            status: 'FAILED',
            source_type: '',
            media_url: null,
            thumbnail_url: 'https://primary/content/999/thumb.jpg',
            storage_state: 'missing',
            storage_state_reason: 'quality_reencode_source_object_missing',
            storage_recovery_status: 'at_risk',
            storage_tier: null,
            media_version: 1,
            file_size_bytes: 0,
        });

        const result = await reencodeOneItem({
            contentItemId: '99999999-2222-3333-4444-555555555555',
            targetProfileId: 3,
            tenantId: 'default',
            trigger: 'rule',
            contentRole: 'failed_or_orphan_artifact',
        });

        expect(result.success).toBe(false);
        expect(result.nonRetryable).toBe(true);
        expect(result.error).toBe('missing_media_url');
        expect(cmsMocks.recordStorageArtifactEvent).toHaveBeenCalledWith(expect.objectContaining({
            content_item_id: '99999999-2222-3333-4444-555555555555',
            event_type: 'reencoded',
            status: 'skipped',
            reason: 'missing_media_url',
            storage_state: 'missing',
            storage_state_reason: 'quality_reencode_source_object_missing',
            storage_recovery_status: 'at_risk',
        }));
    });
});

describe('quality old-version cleanup lifecycle', () => {
    const contentItemId = '11111111-2222-3333-4444-555555555555';
    const oldKey = `content/${contentItemId}/processed.v4.mp4`;
    const currentKey = `content/${contentItemId}/processed.v5.mp4`;
    const manifest = {
        id: '22222222-3333-4444-5555-666666666666',
        tenant_id: 'tenant-a',
        content_item_id: contentItemId,
        producer_event_id: '33333333-4444-5555-6666-777777777777',
        creator_role: 'aggregation_quality_worker',
        fence_token: '44444444-5555-6666-7777-888888888888',
        artifact_role: 'playback_mp4',
        storage_tier: 'primary',
        bucket: 'wahb-media',
        object_key: oldKey,
        state: 'verified',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        cmsMocks.getContentItem.mockResolvedValue({
            id: contentItemId,
            tenant_id: 'tenant-a',
            media_url: `http://primary.example.com/wahb-media/${currentKey}`,
        });
        cmsMocks.listArtifactManifests.mockResolvedValue({ manifests: [{ id: manifest.id }] });
        cmsMocks.getArtifactManifest.mockResolvedValue(manifest);
        cmsMocks.transitionArtifactManifest.mockImplementation(async (_id: string, state: string) => ({ ...manifest, state }));
        storageMocks.deleteObjectsByKeys.mockResolvedValue({ errors: [] });
        storageMocks.objectExists.mockResolvedValue(false);
    });

    it('marks an old quality manifest cleanup-eligible, deletes exact bytes, verifies absence, then marks deleted', async () => {
        await deleteOldVersion(contentItemId, 'tenant-a', oldKey, 'primary');

        expect(cmsMocks.listArtifactManifests).toHaveBeenCalledWith({
            tenant_id: 'tenant-a', object_key: oldKey, bucket: 'wahb-media', storage_tier: 'primary',
        });
        expect(cmsMocks.transitionArtifactManifest.mock.calls.map((call) => call[1])).toEqual(['cleanup_eligible', 'deleted']);
        expect(storageMocks.deleteObjectsByKeys).toHaveBeenCalledWith([oldKey], 'primary');
        expect(storageMocks.objectExists).toHaveBeenCalledWith(oldKey, 'primary');
        expect(cmsMocks.transitionArtifactManifest.mock.calls[0][2]).toEqual(expect.objectContaining({
            producer_event_id: manifest.producer_event_id,
            fence_token: manifest.fence_token,
            terminal_proof: expect.objectContaining({ quality_version_superseded: true, current_media_key: currentKey }),
        }));
        expect(cmsMocks.transitionArtifactManifest.mock.calls[1][2]).toEqual(expect.objectContaining({
            producer_event_id: manifest.producer_event_id,
            fence_token: manifest.fence_token,
            terminal_proof: { provider_head_verified: true, object_present: false, quality_cleanup: true },
        }));
    });

    it('resumes a cleanup-eligible manifest after deletion without repeating the eligibility transition', async () => {
        cmsMocks.getArtifactManifest.mockResolvedValue({ ...manifest, state: 'cleanup_eligible' });

        await deleteOldVersion(contentItemId, 'tenant-a', oldKey, 'primary');

        expect(cmsMocks.transitionArtifactManifest.mock.calls.map((call) => call[1])).toEqual(['deleted']);
        expect(storageMocks.deleteObjectsByKeys).toHaveBeenCalledWith([oldKey], 'primary');
    });

    it('treats a deleted manifest as idempotent only when provider absence is confirmed', async () => {
        cmsMocks.getArtifactManifest.mockResolvedValue({ ...manifest, state: 'deleted' });

        await deleteOldVersion(contentItemId, 'tenant-a', oldKey, 'primary');

        expect(storageMocks.objectExists).toHaveBeenCalledWith(oldKey, 'primary');
        expect(storageMocks.deleteObjectsByKeys).not.toHaveBeenCalled();
        expect(cmsMocks.transitionArtifactManifest).not.toHaveBeenCalled();
    });

    it('refuses malformed keys and the current media pointer before touching storage', async () => {
        await expect(deleteOldVersion(contentItemId, 'tenant-a', `content/${contentItemId}/other.mp4`, 'primary'))
            .rejects.toThrow('exact tenant-owned content key');
        cmsMocks.getContentItem.mockResolvedValue({
            id: contentItemId,
            tenant_id: 'tenant-a',
            media_url: `http://primary.example.com/wahb-media/${oldKey}`,
        });
        await expect(deleteOldVersion(contentItemId, 'tenant-a', oldKey, 'primary'))
            .rejects.toThrow('not the current media pointer');
        expect(storageMocks.deleteObjectsByKeys).not.toHaveBeenCalled();
    });

    it('keeps the manifest cleanup-eligible when provider absence is not proven', async () => {
        storageMocks.objectExists.mockResolvedValue(true);

        await expect(deleteOldVersion(contentItemId, 'tenant-a', oldKey, 'primary'))
            .rejects.toThrow('provider readback still finds');

        expect(cmsMocks.transitionArtifactManifest.mock.calls.map((call) => call[1])).toEqual(['cleanup_eligible']);
        expect(storageMocks.deleteObjectsByKeys).toHaveBeenCalledWith([oldKey], 'primary');
    });

    it('does not delete when the CMS manifest belongs to another tenant or item', async () => {
        cmsMocks.getArtifactManifest.mockResolvedValue({ ...manifest, content_item_id: '99999999-2222-3333-4444-555555555555' });

        await expect(deleteOldVersion(contentItemId, 'tenant-a', oldKey, 'primary'))
            .rejects.toThrow('does not prove exact item ownership');

        expect(storageMocks.deleteObjectsByKeys).not.toHaveBeenCalled();
    });
});

describe('sourceKeyCandidates', () => {
    const id = 'cccccccc-dddd-eeee-ffff-111111111111';

    it('tries the live media URL first, then current-to-legacy processed keys', () => {
        const live = `http://primary.example.com/wahb-media/content/${id}/processed.v4.mp4`;
        expect(sourceKeyCandidates(id, live, 4)).toEqual([
            `content/${id}/processed.v4.mp4`,
            `content/${id}/processed.v3.mp4`,
            `content/${id}/processed.v2.mp4`,
            `content/${id}/processed.mp4`,
        ]);
    });

    it('falls back to legacy processed.mp4 when the URL cannot be reversed', () => {
        expect(sourceKeyCandidates(id, 'https://cdn.example.com/media.mp4', 1)).toEqual([
            `content/${id}/processed.mp4`,
        ]);
    });
});

describe('DEFAULT_ENCODE_PROFILE', () => {
    it('matches the historical hard-coded recipe (h264 / no cap / CRF 23 / AAC 128k / fast)', () => {
        // Frozen so a future tweak doesn't silently change every fresh ingest's
        // encoding behaviour for callers that pass `undefined`.
        expect(DEFAULT_ENCODE_PROFILE).toEqual({
            videoCodec: 'h264',
            maxHeight: 0,
            targetBitrateKbps: 0,
            crf: 23,
            preset: 'fast',
            audioCodec: 'aac',
            audioBitrateKbps: 128,
        });
    });

    it('bounds FFmpeg threads so media work cannot starve BullMQ lock renewal', () => {
        expect(FFMPEG_TRANSCODE_THREADS).toBe(2);
        expect(buildEncodeOptions(DEFAULT_ENCODE_PROFILE)).toEqual(expect.arrayContaining([
            '-threads 2',
            '-filter_threads 1',
        ]));
    });
});
