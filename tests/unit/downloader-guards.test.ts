import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    assertContentLengthWithinCap,
    boundedAppend,
    findExistingYouTubeDownload,
    isAllowedYouTubeUrl,
    selectCachedYouTubeFallback,
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
        expect(YOUTUBE_VIDEO_FORMAT).not.toMatch(/bestvideo\[ext=mp4\](?!.*height)/);
        expect(YOUTUBE_FORCE_OVERWRITE_ARGS).toContain('--force-overwrites');
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
            formats: [
                { url: 'https://cdn.example/video-only', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'none' },
                { url: 'https://cdn.example/too-tall', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'aac' },
                { url: 'https://cdn.example/muxed-webm', ext: 'webm', height: 720, vcodec: 'vp9', acodec: 'opus' },
                { url: 'https://cdn.example/muxed-mp4', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'aac' },
            ],
        })).toEqual({
            url: 'https://cdn.example/muxed-mp4',
            extension: 'mp4',
            height: 720,
        });
    });

    it('rejects unsafe, oversized, video-only, and above-ceiling formats', () => {
        expect(selectCachedYouTubeFallback({
            formats: [
                { url: 'file:///tmp/video.mp4', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'aac' },
                { url: 'https://cdn.example/large', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'aac', filesize: 6 * 1024 ** 3 },
                { url: 'https://cdn.example/video-only', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'none' },
            ],
        })).toBeUndefined();
    });
});
