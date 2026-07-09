import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateEmbeddingViaEnrichment } from '../../src/ai/enrichment-client.js';

describe('generateEmbeddingViaEnrichment', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('requests dense embedding write-back and tags without stale sparse flags', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({
                embeddings: [[0.1, 0.2]],
                write_back_status: 'ok',
            }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await generateEmbeddingViaEnrichment(
            'hello',
            'content-id',
            { requestId: 'job-1', extractTags: true },
        );

        expect(result.writeBackStatus).toBe('ok');
        const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
        const body = JSON.parse(String(request.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
            texts: ['hello'],
            content_ids: ['content-id'],
            extract_tags: true,
        });
        expect(body).not.toHaveProperty('extract_sparse');
    });
});
