import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    assertContentLengthWithinCap,
    boundedAppend,
    buildYtDlpProviderArgs,
    classifyYouTubeFailure,
    findExistingYouTubeDownload,
    isAllowedYouTubeUrl,
    selectCachedYouTubeFallback,
    youtubeVideoId,
    youtubeSourceProfileFailure,
    YOUTUBE_FORCE_OVERWRITE_ARGS,
    YOUTUBE_VIDEO_FORMAT,
} from '../../src/media/downloader.js';

describe('assertContentLengthWithinCap', () => {
    it('allows missing content-length headers', () => {
        expect(() => assertContentLengthWithinCap(null, 10)).not.toThrow();
    });

    it('allows declared sizes under the cap', () => {
        expect(() => assertContentLengthWithinCap('9', 10)).not.toThrow();
    });

    it('rejects declared sizes over the cap', () => {
        expect(() => assertContentLengthWithinCap('11', 10)).toThrow(/exceeds size cap/);
    });
});

describe('boundedAppend', () => {
    it('appends normally under the limit', () => {
        expect(boundedAppend('abc', 'def', 10)).toBe('abcdef');
    });

    it('keeps only the tail when the limit is exceeded', () => {
        expect(boundedAppend('abcdef', 'ghij', 5)).toBe('fghij');
    });
});

describe('isAllowedYouTubeUrl', () => {
    it('allows canonical YouTube hosts', () => {
        expect(isAllowedYouTubeUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
        expect(isAllowedYouTubeUrl('https://youtu.be/abc')).toBe(true);
    });

    it('rejects URLs that only contain youtube.com outside the hostname', () => {
        expect(isAllowedYouTubeUrl('https://example.com/watch?next=youtube.com')).toBe(false);
        expect(isAllowedYouTubeUrl('http://169.254.169.254/latest?u=youtube.com')).toBe(false);
    });
});

describe('YOUTUBE_VIDEO_FORMAT', () => {
    it('never downloads video above the canonical 720p ingest ceiling', () => {
        expect(YOUTUBE_VIDEO_FORMAT).toContain('height<=720');
        expect(YOUTUBE_VIDEO_FORMAT).toContain('vcodec!*=av01');
        expect(YOUTUBE_VIDEO_FORMAT).toContain('vcodec!*=av1');
        expect(YOUTUBE_VIDEO_FORMAT).not.toMatch(/bestvideo\[ext=mp4\](?!.*height)/);
        expect(YOUTUBE_FORCE_OVERWRITE_ARGS).toContain('--force-overwrites');
    });
});

describe('youtubeSourceProfileFailure', () => {
    const valid = { hasVideo: true, hasAudio: true, duration: 600, height: 720, videoCodec: 'h264' };

    it('rejects oversized, AV1, and non-muxed downloaded sources', () => {
        expect(youtubeSourceProfileFailure({ ...valid, height: 2160 })).toMatch(/720p ingest ceiling/);
        expect(youtubeSourceProfileFailure({ ...valid, videoCodec: 'av1' })).toMatch(/prohibited AV1/);
        expect(youtubeSourceProfileFailure({ ...valid, videoCodec: 'av01.0.08M.08' })).toMatch(/prohibited AV1/);
        expect(youtubeSourceProfileFailure({ ...valid, hasAudio: false })).toMatch(/muxed audio\/video/);
    });

    it('accepts a bounded muxed H.264 source', () => {
        expect(youtubeSourceProfileFailure(valid)).toBeUndefined();
    });
});

describe('YouTube challenge classification and identity', () => {
    it('recognizes current and legacy bot-confirmation messages', () => {
        expect(classifyYouTubeFailure("Sign in to confirm you're not a bot")).toBe('bot_challenge');
        expect(classifyYouTubeFailure('ERROR: use --cookies-from-browser or --cookies')).toBe('bot_challenge');
        expect(classifyYouTubeFailure('HTTP Error 429: Too Many Requests')).toBe('rate_limited');
        expect(classifyYouTubeFailure('HTTP Error 403: Forbidden; PO Token required')).toBe('attestation_required');
        expect(classifyYouTubeFailure('No supported JavaScript runtime could solve the challenge')).toBe('attestation_required');
        expect(classifyYouTubeFailure('This is a private video')).toBe('unavailable');
        expect(classifyYouTubeFailure('Login required for members-only content')).toBe('authentication_required');
        expect(classifyYouTubeFailure('The configured cookies have expired and are no longer valid')).toBe('credential_expired');
    });

    it('extracts video identity from supported YouTube URL forms', () => {
        expect(youtubeVideoId('https://www.youtube.com/watch?v=abc123')).toBe('abc123');
        expect(youtubeVideoId('https://youtu.be/abc123?t=1')).toBe('abc123');
        expect(youtubeVideoId('https://www.youtube.com/shorts/abc123')).toBe('abc123');
    });

    it('enables the managed JS runtime and optional PO-token provider explicitly', () => {
        expect(buildYtDlpProviderArgs()).toEqual(['--js-runtimes', 'node']);
        expect(buildYtDlpProviderArgs('http://127.0.0.1:4416')).toEqual([
            '--js-runtimes', 'node',
            '--extractor-args', 'youtube:player-client=mweb',
            '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',
        ]);
    });
});

describe('findExistingYouTubeDownload', () => {
    it('finds only a complete canonical same-item source artifact', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wahb-ytdlp-cleanup-'));
        try {
            await Promise.all([
                writeFile(join(dir, 'item-1.mp4'), 'complete source'),
                writeFile(join(dir, 'item-1_processed.mp4'), 'transcode'),
                writeFile(join(dir, 'item-2.mp4'), 'other source'),
            ]);

            await expect(findExistingYouTubeDownload('item-1', dir)).resolves.toEqual({
                filePath: join(dir, 'item-1.mp4'),
                format: 'mp4',
            });
            await expect(findExistingYouTubeDownload('missing', dir)).resolves.toBeUndefined();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('selectCachedYouTubeFallback', () => {
    it('selects the highest bounded muxed format and prefers mp4 at the same height', () => {
        expect(selectCachedYouTubeFallback({
            id: 'video-1',
            formats: [
                { url: 'https://cdn.example/video-only', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'none' },
                { url: 'https://cdn.example/too-tall', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'aac' },
                { url: 'https://cdn.example/muxed-webm', ext: 'webm', height: 720, vcodec: 'vp9', acodec: 'opus' },
                { url: 'https://cdn.example/muxed-mp4', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'aac' },
            ],
        }, 'video-1')).toEqual({
            url: 'https://cdn.example/muxed-mp4',
            extension: 'mp4',
            height: 720,
            videoCodec: 'avc1',
        });
    });

    it('rejects unsafe, oversized, video-only, and above-ceiling formats', () => {
        expect(selectCachedYouTubeFallback({
            id: 'video-1',
            formats: [
                { url: 'file:///tmp/video.mp4', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'aac' },
                { url: 'https://cdn.example/large', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'aac', filesize: 6 * 1024 ** 3 },
                { url: 'https://cdn.example/video-only', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'none' },
            ],
        }, 'video-1')).toBeUndefined();
    });

    it('rejects AV1, expired signed URLs, and metadata from another video', () => {
        const now = new Date('2026-08-26T12:00:00Z');
        const metadata = {
            id: 'video-1',
            formats: [
                { url: 'https://cdn.example/av1', ext: 'mp4', height: 720, vcodec: 'av01.0.05M.08', acodec: 'aac' },
                { url: `https://cdn.example/expired?expire=${Math.floor(now.getTime() / 1000)}`, ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'aac' },
            ],
        };
        expect(selectCachedYouTubeFallback(metadata, 'video-1', now)).toBeUndefined();
        expect(selectCachedYouTubeFallback(metadata, 'another-video', now)).toBeUndefined();
    });
});
