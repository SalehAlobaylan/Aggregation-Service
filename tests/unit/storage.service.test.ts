import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getStorageOpBudget: vi.fn(),
    listStorageCandidates: vi.fn(),
    listContentItems: vi.fn(),
    recordStorageArtifactEvent: vi.fn(),
    createSweepRun: vi.fn(),
    archiveItems: vi.fn(),
	startStorageOperationSaga: vi.fn(),
	markStorageSagaObjectApplied: vi.fn(),
    resolveQualityProfile: vi.fn(),
    deleteContentObjects: vi.fn(),
    computeStorageUsage: vi.fn(),
    listAllObjects: vi.fn(),
    moveObjectBetweenTiers: vi.fn(),
    isColdTierConfigured: vi.fn(),
    getQueue: vi.fn(),
}));

vi.mock('../../src/cms/client.js', () => ({
    cmsClient: {
        getStorageOpBudget: mocks.getStorageOpBudget,
        listStorageCandidates: mocks.listStorageCandidates,
        listContentItems: mocks.listContentItems,
        recordStorageArtifactEvent: mocks.recordStorageArtifactEvent,
        createSweepRun: mocks.createSweepRun,
        archiveItems: mocks.archiveItems,
		startStorageOperationSaga: mocks.startStorageOperationSaga,
		markStorageSagaObjectApplied: mocks.markStorageSagaObjectApplied,
        resolveQualityProfile: mocks.resolveQualityProfile,
    },
}));

vi.mock('../../src/storage/client.js', () => ({
    deleteContentObjects: mocks.deleteContentObjects,
    computeStorageUsage: mocks.computeStorageUsage,
    listAllObjects: mocks.listAllObjects,
    moveObjectBetweenTiers: mocks.moveObjectBetweenTiers,
    isColdTierConfigured: mocks.isColdTierConfigured,
}));

vi.mock('../../src/queues/index.js', () => ({
    QUEUE_NAMES: { QUALITY_REENCODE: 'quality-reencode' },
    getQueue: mocks.getQueue,
}));

vi.mock('../../src/observability/logger.js', () => ({
    logger: {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
    },
}));

import { reconcileStorage, runSweepForTenant } from '../../src/services/storage.service.js';
import type { StoragePolicy } from '../../src/cms/types.js';

function policy(overrides: Partial<StoragePolicy> = {}): StoragePolicy {
    return {
        id: 1,
        tenant_id: 'default',
        enabled: true,
        preset: 'balanced',
        max_storage_bytes: 1_000,
        target_utilization_pct: 80,
        min_age_days: 14,
        min_view_count_for_keep: 5,
        sweep_interval_minutes: 60,
        delete_failed_immediately: true,
        preserve_thumbnails: true,
        protect_top_n_by_views: 50,
        protect_top_n_window_days: 30,
        archive_action: 'delete',
        re_encode_target_profile_id: null,
        updated_at: new Date().toISOString(),
        ...overrides,
    };
}

describe('runSweepForTenant delete safety', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getStorageOpBudget.mockResolvedValue({ class_a_status: 'ok' });
        mocks.computeStorageUsage.mockResolvedValue({ usedBytes: 950, objectCount: 1, byArtifactType: {} });
        mocks.isColdTierConfigured.mockReturnValue(false);
        mocks.recordStorageArtifactEvent.mockResolvedValue({ success: true });
        mocks.createSweepRun.mockResolvedValue({ success: true });
        mocks.archiveItems.mockResolvedValue({ updated_count: 1, freed_bytes: 123_456 });
		mocks.startStorageOperationSaga.mockResolvedValue({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', state: 'prepared', created: true });
		mocks.markStorageSagaObjectApplied.mockResolvedValue(undefined);
        mocks.resolveQualityProfile.mockResolvedValue({ profile: { id: 3 }, matched_on: 'global' });
        mocks.listStorageCandidates.mockResolvedValue({
            data: [{
                id: '11111111-2222-3333-4444-555555555555',
                type: 'PODCAST',
                status: 'ARCHIVED',
                media_url: 'https://primary/content/111/processed.mp4',
                thumbnail_url: 'https://primary/content/111/thumb.jpg',
                file_size_bytes: 123_456,
                view_count: 0,
                created_at: new Date().toISOString(),
                parent_content_item_id: undefined,
                is_feed_unit: false,
                feed_visibility: 'hidden',
                duration_sec: 7_200,
                original_url: 'https://example.com/episode.mp4',
                source_feed_url: 'https://example.com/feed.xml',
                source_episode_id: 'episode-1',
                media_suitability: 'audio_first_talking_head',
                content_role: 'atomized_parent_source',
            }],
            total: 1,
            total_bytes: 123_456,
        });
    });

    it('records approval-required ledger events instead of deleting during automatic sweeps', async () => {
        const result = await runSweepForTenant(policy(), 'auto');

        expect(mocks.deleteContentObjects).not.toHaveBeenCalled();
        expect(mocks.recordStorageArtifactEvent).toHaveBeenCalledWith(expect.objectContaining({
            content_item_id: '11111111-2222-3333-4444-555555555555',
            event_type: 'recoverable_deleted',
            status: 'approval_required',
            reason: 'degraded_no_cold_delete_requires_approval',
            trigger: 'auto',
        }));
        expect(mocks.createSweepRun).toHaveBeenCalledWith(expect.objectContaining({
            deleted_count: 0,
            freed_bytes: 0,
            trigger: 'auto',
            error: 'degraded_no_cold_delete_requires_approval',
        }));
        expect(result.deletedCount).toBe(0);
        expect(result.freedBytes).toBe(0);
    });

    it('allows manual recoverable deletion after operator approval', async () => {
        mocks.deleteContentObjects.mockResolvedValue({ deletedCount: 2, freedBytes: 123_456, errors: [] });

        const result = await runSweepForTenant(policy(), 'manual');

        expect(mocks.deleteContentObjects).toHaveBeenCalledWith(
            '11111111-2222-3333-4444-555555555555',
            ['processed', 'original']
        );
		expect(mocks.startStorageOperationSaga).toHaveBeenCalledWith(expect.objectContaining({
			content_item_id: '11111111-2222-3333-4444-555555555555',
			operation: 'recoverable_delete',
		}));
		expect(mocks.markStorageSagaObjectApplied).toHaveBeenCalledWith(
			'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
			expect.objectContaining({ deleted_count: 2 }),
		);
        expect(result.deletedCount).toBe(2);
        expect(result.freedBytes).toBe(123_456);
    });

    it('uses role-aware storage-saver profile for dormant/parent re-encode candidates', async () => {
        const queue = {
            getJob: vi.fn().mockResolvedValue(null),
            add: vi.fn().mockResolvedValue({ id: 'job-1' }),
        };
        mocks.getQueue.mockReturnValue(queue);

        const result = await runSweepForTenant(policy({ archive_action: 're_encode' }), 'auto');

        expect(mocks.resolveQualityProfile).toHaveBeenCalledWith(expect.objectContaining({
            preset_key: 'storage-saver',
        }));
        expect(queue.add).toHaveBeenCalledWith('reencode', expect.objectContaining({
            contentItemId: '11111111-2222-3333-4444-555555555555',
            targetProfileId: 3,
            contentRole: 'atomized_parent_source',
        }), expect.objectContaining({
            jobId: 'reencode-default-11111111-2222-3333-4444-555555555555-3-atomized_parent_source',
        }));
        expect(result.reEncodedCount).toBe(1);
    });

    it('skips re-encode candidates that have no media artifact to shrink', async () => {
        const queue = {
            getJob: vi.fn().mockResolvedValue(null),
            add: vi.fn().mockResolvedValue({ id: 'job-1' }),
        };
        mocks.getQueue.mockReturnValue(queue);
        mocks.listStorageCandidates.mockResolvedValue({
            data: [{
                id: '99999999-2222-3333-4444-555555555555',
                type: 'NEWS',
                status: 'FAILED',
                media_url: undefined,
                thumbnail_url: 'https://primary/content/999/thumb.jpg',
                file_size_bytes: 123_456,
                view_count: 0,
                created_at: new Date().toISOString(),
                parent_content_item_id: undefined,
                is_feed_unit: true,
                feed_visibility: 'visible',
                duration_sec: undefined,
                media_suitability: 'unknown',
                content_role: 'failed_or_orphan_artifact',
            }],
            total: 1,
            total_bytes: 123_456,
        });

        const result = await runSweepForTenant(policy({ archive_action: 're_encode' }), 'auto');

        expect(queue.add).not.toHaveBeenCalled();
        expect(mocks.recordStorageArtifactEvent).toHaveBeenCalledWith(expect.objectContaining({
            content_item_id: '99999999-2222-3333-4444-555555555555',
            event_type: 'reencoded',
            status: 'skipped',
            reason: 'missing_media_url',
        }));
        expect(result.reEncodedCount).toBe(0);
    });
});

describe('reconcileStorage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('indexes object keys by content id instead of treating existing CMS objects as orphan', async () => {
        async function* pages() {
            yield [
                { Key: 'content/11111111-2222-3333-4444-555555555555/processed.mp4', Size: 100 },
                { Key: 'content/22222222-2222-3333-4444-555555555555/processed.mp4', Size: 100 },
                { Key: 'loose/orphan.bin', Size: 50 },
            ];
        }
        mocks.listAllObjects.mockImplementation(pages);
        mocks.listContentItems.mockImplementation(async (params: { ids?: string[]; page?: number }) => {
            if (params.ids?.length) {
                return {
                    data: params.ids.includes('11111111-2222-3333-4444-555555555555')
                        ? [{ id: '11111111-2222-3333-4444-555555555555', metadata: {}, type: 'VIDEO', source: 'YOUTUBE', status: 'READY', original_url: '' }]
                        : [],
                    total: 1,
                    page: 1,
                    limit: params.ids.length,
                };
            }
            return { data: [], total: 0, page: params.page ?? 1, limit: 500 };
        });

        const result = await reconcileStorage();

        expect(result.orphanKeys).toEqual([
            'content/22222222-2222-3333-4444-555555555555/processed.mp4',
            'loose/orphan.bin',
        ]);
        expect(result.scannedObjectCount).toBe(3);
        expect(result.partial).toBe(false);
    });
});
