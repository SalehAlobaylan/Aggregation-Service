import { describe, expect, it } from 'vitest';
import { matchesArtifactFamily } from '../../src/storage/client.js';

describe('artifact-family matching', () => {
    const retained = new Set(['processed', 'original']);

    it('includes versioned processed artifacts and nested HLS-like children', () => {
        expect(matchesArtifactFamily('content/id/processed.mp4', retained)).toBe(true);
        expect(matchesArtifactFamily('content/id/processed.v2.mp4', retained)).toBe(true);
        expect(matchesArtifactFamily('content/id/processed/segment-0001.ts', retained)).toBe(true);
        expect(matchesArtifactFamily('content/id/hls/index.m3u8', retained)).toBe(true);
        expect(matchesArtifactFamily('content/id/hls/segment-0001.ts', retained)).toBe(true);
        expect(matchesArtifactFamily('content/id/pipeline-repair/attempt/processed.mp4', retained)).toBe(true);
        expect(matchesArtifactFamily('content/id/original_backup.mp4', retained)).toBe(true);
    });

    it('does not select unrelated artifact families', () => {
        expect(matchesArtifactFamily('content/id/thumbnail.jpg', retained)).toBe(false);
        expect(matchesArtifactFamily('content/id/pipeline-repair/attempt/thumbnail.jpg', retained)).toBe(false);
        expect(matchesArtifactFamily('content/id/other/segment.ts', retained)).toBe(false);
    });
});
