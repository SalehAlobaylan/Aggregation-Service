import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { internalRoutes } from '../../src/server/routes/internal.js';

const mocks = vi.hoisted(() => ({
    add: vi.fn().mockResolvedValue({ id: 'user-content-content-1' }),
    getJob: vi.fn().mockResolvedValue(null),
    getStorageKey: vi.fn((contentItemId: string, artifactType: string, ext: string) =>
        `content/${contentItemId}/${artifactType}.${ext}`
    ),
    uploadBuffer: vi.fn().mockResolvedValue('https://storage.example.com/content/content-1/original.mp3'),
}));

vi.mock('../../src/queues/index.js', () => ({
    QUEUE_NAMES: {
        AI: 'ai-queue',
        DISCOVERY_SWEEP: 'discovery-sweep-queue',
        MEDIA: 'media-queue',
        NEWS_CIRCULATION: 'news-circulation-queue',
        SOURCE_GRAPH: 'source-graph-queue',
    },
    getQueue: vi.fn((name: string) => {
        if (name === 'media-queue') {
            return {
                add: mocks.add,
                getJob: mocks.getJob,
            };
        }
        return undefined;
    }),
}));

vi.mock('../../src/storage/client.js', () => ({
    getStorageKey: mocks.getStorageKey,
    uploadBuffer: mocks.uploadBuffer,
}));

vi.mock('../../src/server/plugins/internal-auth.js', () => ({
    verifyInternalServiceAuth: vi.fn(async () => undefined),
}));

vi.mock('../../src/cms/client.js', () => ({
    cmsClient: {
        listContentItems: vi.fn(),
        updateStatus: vi.fn(),
    },
}));

vi.mock('../../src/observability/logger.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

function userContentParts() {
    return async function* parts() {
        yield { type: 'field', fieldname: 'content_item_id', value: 'content-1' };
        yield { type: 'field', fieldname: 'content_type', value: 'PODCAST' };
        yield { type: 'field', fieldname: 'tenant_id', value: 'default' };
        yield {
            type: 'file',
            fieldname: 'audio_file',
            filename: 'episode.mp3',
            mimetype: 'audio/mpeg',
            toBuffer: vi.fn().mockResolvedValue(Buffer.from('audio')),
        };
    };
}

async function buildServer() {
    const fastify = Fastify();
    fastify.addHook('preHandler', async (request) => {
        (request as unknown as { parts: () => AsyncIterableIterator<unknown> }).parts = userContentParts();
    });
    await fastify.register(internalRoutes);
    return fastify;
}

describe('internal user-content route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getJob.mockResolvedValue(null);
        mocks.uploadBuffer.mockResolvedValue('https://storage.example.com/content/content-1/original.mp3');
        mocks.add.mockResolvedValue({ id: 'user-content-content-1' });
    });

    it('returns an existing active user-content job without uploading or enqueueing again', async () => {
        mocks.getJob.mockResolvedValue({
            id: 'user-content-content-1',
            getState: vi.fn().mockResolvedValue('active'),
            remove: vi.fn(),
        });
        const server = await buildServer();

        const response = await server.inject({
            method: 'POST',
            url: '/internal/jobs/user-content',
        });

        expect(response.statusCode).toBe(202);
        expect(response.json()).toEqual({
            success: true,
            contentItemId: 'content-1',
            jobId: 'user-content-content-1',
        });
        expect(mocks.uploadBuffer).not.toHaveBeenCalled();
        expect(mocks.add).not.toHaveBeenCalled();
        await server.close();
    });

    it('removes a failed user-content job and enqueues with a deterministic job id', async () => {
        const remove = vi.fn().mockResolvedValue(undefined);
        mocks.getJob.mockResolvedValue({
            id: 'user-content-content-1',
            getState: vi.fn().mockResolvedValue('failed'),
            remove,
        });
        const server = await buildServer();

        const response = await server.inject({
            method: 'POST',
            url: '/internal/jobs/user-content',
        });

        expect(response.statusCode).toBe(202);
        expect(remove).toHaveBeenCalledOnce();
        expect(mocks.uploadBuffer).toHaveBeenCalledOnce();
        expect(mocks.add).toHaveBeenCalledWith(
            'user-content',
            expect.objectContaining({
                contentItemId: 'content-1',
                contentType: 'PODCAST',
                sourceType: 'UPLOAD',
                sourceUrl: 'https://storage.example.com/content/content-1/original.mp3',
            }),
            { priority: 2, jobId: 'user-content-content-1' }
        );
        await server.close();
    });
});
