import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createWorker: vi.fn((value: unknown) => value),
    getQueue: vi.fn(),
    listArtifactManifests: vi.fn(),
    getArtifactManifest: vi.fn(),
    transitionArtifactManifest: vi.fn(),
    reconcileArtifactCompleteStatuses: vi.fn(),
    listMissingEmbedding: vi.fn(),
    getObjectMetadata: vi.fn(),
    readObjectDigest: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}));

vi.mock('../../src/workers/base-worker.js', () => ({ createWorker: mocks.createWorker }));
vi.mock('../../src/queues/index.js', () => ({
    QUEUE_NAMES: { RECONCILE: 'reconcile-queue', AI: 'ai-queue' },
    getQueue: mocks.getQueue,
}));
vi.mock('../../src/cms/client.js', () => ({
    cmsClient: {
        listArtifactManifests: mocks.listArtifactManifests,
        getArtifactManifest: mocks.getArtifactManifest,
        transitionArtifactManifest: mocks.transitionArtifactManifest,
        reconcileArtifactCompleteStatuses: mocks.reconcileArtifactCompleteStatuses,
        listMissingEmbedding: mocks.listMissingEmbedding,
    },
}));
vi.mock('../../src/config/index.js', () => ({
    config: { reconcileBatch: 10, coldStorageBucket: null, storageBucket: 'wahb-media' },
}));
vi.mock('../../src/observability/logger.js', () => ({
    logger: { info: mocks.info, debug: mocks.debug, warn: mocks.warn, error: mocks.error },
}));
vi.mock('../../src/storage/client.js', () => ({
    getObjectMetadata: mocks.getObjectMetadata,
    readObjectDigest: mocks.readObjectDigest,
}));

const { createReconcileWorker } = await import('../../src/workers/reconcile.worker.js');

const contentItemId = '11111111-2222-3333-4444-555555555555';
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
    object_key: `content/${contentItemId}/processed.v2.mp4`,
    content_type: 'video/mp4',
    size_bytes: 100,
    etag: 'original-etag',
    sha256: 'a'.repeat(64),
    state: 'uploaded',
};

describe('quality artifact reconciliation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createWorker.mockImplementation((value: unknown) => value);
        mocks.listArtifactManifests.mockImplementation(async (params: { atomization?: boolean }) => ({
            manifests: params.atomization ? [] : [manifest],
        }));
        mocks.getArtifactManifest.mockResolvedValue(manifest);
        mocks.transitionArtifactManifest.mockResolvedValue({ ...manifest, state: 'verified' });
        mocks.reconcileArtifactCompleteStatuses.mockResolvedValue({ reconciled: 0 });
        mocks.listMissingEmbedding.mockResolvedValue({ items: [] });
        mocks.getObjectMetadata.mockResolvedValue({
            exists: true,
            size: 100,
            contentType: 'video/mp4',
            etag: '"original-etag"',
        });
        mocks.readObjectDigest.mockResolvedValue({ bytes: 100, sha256: 'a'.repeat(64) });
    });

    async function runSweep() {
        const worker = createReconcileWorker() as unknown as {
            processor: (job: unknown, logger: unknown) => Promise<void>;
        };
        await worker.processor({ id: 'reconcile-1', data: {} }, {
            info: mocks.info,
            debug: mocks.debug,
            warn: mocks.warn,
            error: mocks.error,
        });
    }

    it('adopts only the exact quality bytes under the original producer and fence', async () => {
        await runSweep();

        expect(mocks.readObjectDigest).toHaveBeenCalledWith(
            manifest.object_key,
            manifest.size_bytes,
            'primary',
            expect.any(AbortSignal),
        );
        expect(mocks.transitionArtifactManifest).toHaveBeenCalledWith(manifest.id, 'verified', expect.objectContaining({
            tenant_id: manifest.tenant_id,
            producer_event_id: manifest.producer_event_id,
            fence_token: manifest.fence_token,
            etag: '"original-etag"',
            sha256: manifest.sha256,
            content_type: 'video/mp4',
            verification_evidence: expect.objectContaining({
                reconciled: true,
                provider_head_verified: true,
                provider_checksum_sha256: manifest.sha256,
            }),
        }), 'reconcile-1');
    });

    it('does not adopt an object whose ETag, media type, size, or digest conflicts', async () => {
        mocks.getObjectMetadata.mockResolvedValue({ exists: true, size: 100, contentType: 'video/mp4', etag: 'replacement-etag' });
        await runSweep();
        expect(mocks.transitionArtifactManifest).not.toHaveBeenCalled();

        vi.clearAllMocks();
        mocks.createWorker.mockImplementation((value: unknown) => value);
        mocks.listArtifactManifests.mockImplementation(async (params: { atomization?: boolean }) => ({ manifests: params.atomization ? [] : [manifest] }));
        mocks.getArtifactManifest.mockResolvedValue(manifest);
        mocks.transitionArtifactManifest.mockResolvedValue(undefined);
        mocks.reconcileArtifactCompleteStatuses.mockResolvedValue({ reconciled: 0 });
        mocks.listMissingEmbedding.mockResolvedValue({ items: [] });
        mocks.getObjectMetadata.mockResolvedValue({ exists: true, size: 100, contentType: 'video/mp4', etag: 'original-etag' });
        mocks.readObjectDigest.mockResolvedValue({ bytes: 100, sha256: 'b'.repeat(64) });
        await runSweep();
        expect(mocks.transitionArtifactManifest).not.toHaveBeenCalled();
    });

    it('leaves a still-uploading quality manifest to its producer', async () => {
        mocks.listArtifactManifests.mockImplementation(async (params: { atomization?: boolean }) => ({
            manifests: params.atomization ? [] : [{ ...manifest, state: 'uploading' }],
        }));
        mocks.getArtifactManifest.mockResolvedValue({ ...manifest, state: 'uploading' });

        await runSweep();

        expect(mocks.getObjectMetadata).not.toHaveBeenCalled();
        expect(mocks.transitionArtifactManifest).not.toHaveBeenCalled();
    });

    it('withholds reconciliation when the credential projection fence differs from the manifest', async () => {
        mocks.getArtifactManifest.mockResolvedValue({ ...manifest, fence_token: '55555555-6666-7777-8888-999999999999' });

        await runSweep();

        expect(mocks.getObjectMetadata).not.toHaveBeenCalled();
        expect(mocks.transitionArtifactManifest).not.toHaveBeenCalled();
    });
});
