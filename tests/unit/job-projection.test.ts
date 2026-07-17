import { describe, expect, it } from 'vitest';
import { safeFailureCode, safeJobMetadata, safePayloadHash } from '../../src/observability/job-projection.js';

describe('job projection redaction', () => {
    it('keeps only operational identifiers and never serializes raw payload secrets', () => {
        const sentinel = 'signed-url-token-secret-transcript';
        const payload = {
            contentItemId: 'content-1',
            sourceId: 'source-1',
            sourceUrl: `https://origin.example/audio.mp3?sig=${sentinel}`,
            textContent: { bodyText: sentinel },
            settings: { apiKey: sentinel },
            mediaPath: `/tmp/${sentinel}`,
            operations: ['transcript', 'embedding'],
        };
        const rendered = JSON.stringify(safeJobMetadata(payload));
        expect(rendered).toContain('content-1');
        expect(rendered).toContain('transcript');
        expect(rendered).not.toContain(sentinel);
        expect(safePayloadHash(payload)).toMatch(/^[a-f0-9]{64}$/);
    });

    it('turns raw failure text into a low-cardinality code', () => {
        expect(safeFailureCode(new Error('GET https://private.example/?token=secret timed out'))).toBe('deadline_exceeded');
        expect(safeFailureCode('upstream returned 403 token=secret')).toBe('authorization_failed');
    });
});
