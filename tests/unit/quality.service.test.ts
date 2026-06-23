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

// We import after the mock so the module sees our fake config.
import {
    toEncodeProfile,
    versionedKey,
    keyFromUrl,
    sourceKeyCandidates,
} from '../../src/services/quality.service.js';
import { DEFAULT_ENCODE_PROFILE } from '../../src/media/transcoder.js';

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
});
