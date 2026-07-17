import Fastify from 'fastify';
import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { internalRoutes } from '../../src/server/routes/internal.js';

const contentItemId = '11111111-1111-4111-8111-111111111111';
const mocks = vi.hoisted(() => ({
    add: vi.fn().mockResolvedValue({ id: 'user-content-11111111-1111-4111-8111-111111111111' }),
    getJob: vi.fn().mockResolvedValue(null),
    getStorageKey: vi.fn((id: string, artifact: string, ext: string) => `content/${id}/${artifact}.${ext}`),
    objectExists: vi.fn().mockResolvedValue(false),
    uploadFile: vi.fn().mockResolvedValue('https://storage.example.com/original.mp3'),
    deleteObject: vi.fn(),
    getContentItem: vi.fn(),
    resolveIngestProfile: vi.fn(),
    preflightCheck: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/queues/index.js', () => ({
    QUEUE_NAMES: { AI: 'ai-queue', DISCOVERY_SWEEP: 'discovery-sweep-queue', MEDIA: 'media-queue', NEWS_CIRCULATION: 'news-circulation-queue', SOURCE_GRAPH: 'source-graph-queue' },
    getQueue: vi.fn((name: string) => name === 'media-queue' ? ({ add: mocks.add, getJob: mocks.getJob }) : undefined),
}));
vi.mock('../../src/storage/client.js', () => ({ getStorageKey: mocks.getStorageKey, objectExists: mocks.objectExists, uploadFile: mocks.uploadFile, deleteObject: mocks.deleteObject }));
vi.mock('../../src/server/plugins/internal-auth.js', () => ({ verifyInternalServiceAuth: vi.fn(async () => undefined) }));
vi.mock('../../src/cms/client.js', () => ({ cmsClient: { getContentItem: mocks.getContentItem, listContentItems: vi.fn(), updateStatus: vi.fn() } }));
vi.mock('../../src/services/quality.service.js', () => ({ resolveIngestProfile: mocks.resolveIngestProfile, preflightCheck: mocks.preflightCheck }));
vi.mock('../../src/observability/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

function userContentParts(overrides: { type?: string; duplicateId?: boolean; bytes?: Buffer } = {}) {
    return async function* parts() {
        yield { type: 'field' as const, fieldname: 'content_item_id', value: contentItemId };
        if (overrides.duplicateId) yield { type: 'field' as const, fieldname: 'content_item_id', value: contentItemId };
        yield { type: 'field' as const, fieldname: 'content_type', value: overrides.type ?? 'PODCAST' };
        yield { type: 'field' as const, fieldname: 'tenant_id', value: 'tenant-a' };
        yield { type: 'file' as const, fieldname: 'audio_file', file: Readable.from([overrides.bytes ?? Buffer.from('ID3audio')]) };
    };
}

async function buildServer(overrides?: Parameters<typeof userContentParts>[0]) {
    const fastify = Fastify();
    fastify.addHook('preHandler', async request => { (request as unknown as { parts: () => AsyncIterableIterator<unknown> }).parts = userContentParts(overrides); });
    await fastify.register(internalRoutes);
    return fastify;
}

describe('internal user-content route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getJob.mockResolvedValue(null);
        mocks.objectExists.mockResolvedValue(false);
        mocks.uploadFile.mockResolvedValue('https://storage.example.com/original.mp3');
        mocks.add.mockResolvedValue({ id: `user-content-${contentItemId}` });
        mocks.getContentItem.mockResolvedValue({ id: contentItemId, tenant_id: 'tenant-a', type: 'PODCAST', status: 'PENDING' });
        mocks.resolveIngestProfile.mockResolvedValue({ rawProfile: null });
        mocks.preflightCheck.mockReturnValue(null);
    });

    it('returns an accepted active user-content job without uploading or enqueueing again', async () => {
        mocks.getJob.mockResolvedValue({ id: `user-content-${contentItemId}`, getState: vi.fn().mockResolvedValue('active') });
        const server = await buildServer();
        const response = await server.inject({ method: 'POST', url: '/internal/jobs/user-content' });
        expect(response.statusCode).toBe(202);
        expect(response.json()).toMatchObject({ success: true, contentItemId, accepted: true, alreadyAccepted: true });
        expect(mocks.uploadFile).not.toHaveBeenCalled();
        expect(mocks.add).not.toHaveBeenCalled();
        await server.close();
    });

    it('streams a valid audio file and queues an authoritative tenant job', async () => {
        const server = await buildServer();
        const response = await server.inject({ method: 'POST', url: '/internal/jobs/user-content' });
        expect(response.statusCode).toBe(202);
        expect(mocks.uploadFile).toHaveBeenCalledOnce();
        expect(mocks.add).toHaveBeenCalledWith('user-content', expect.objectContaining({ contentItemId, tenantId: 'tenant-a', sourceType: 'UPLOAD' }), { priority: 2, jobId: `user-content-${contentItemId}` });
        await server.close();
    });

    it('rejects duplicate fields before CMS, storage, or queue use', async () => {
        const server = await buildServer({ duplicateId: true });
        const response = await server.inject({ method: 'POST', url: '/internal/jobs/user-content' });
        expect(response.statusCode).toBe(400);
        expect(mocks.getContentItem).not.toHaveBeenCalled();
        expect(mocks.uploadFile).not.toHaveBeenCalled();
        await server.close();
    });
});
