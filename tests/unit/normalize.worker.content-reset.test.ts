import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ begin: vi.fn(), normalize: vi.fn(), upsert: vi.fn(), heartbeat: vi.fn(), dedup: vi.fn(), grant: vi.fn(), disposition: vi.fn(), receipt: vi.fn() }));
vi.mock('../../src/workers/base-worker.js', () => ({ createWorker: (definition: unknown) => definition }));
vi.mock('../../src/normalizers/index.js', () => ({ normalizeItem: mocks.normalize }));
vi.mock('../../src/services/dedup.service.js', () => ({ dedupService: { checkDedup: mocks.dedup } }));
vi.mock('../../src/cms/upsert.js', () => ({ upsertContentItem: mocks.upsert }));
vi.mock('../../src/cms/client.js', () => ({ cmsClient: { beginSourceRunUnit: mocks.begin, issueContentResetReconstructionGrant: mocks.grant, recordSourceRunUpstreamObservationDisposition: mocks.disposition } }));
vi.mock('../../src/services/lifecycle-receipts.js', () => ({ buildSourceRunReceipt: (input: unknown) => input, enqueueSourceRunReceipt: mocks.receipt }));
vi.mock('../../src/services/source-run-lease.js', () => ({ startSourceRunLeaseHeartbeat: mocks.heartbeat }));
vi.mock('../../src/queues/index.js', () => ({ QUEUE_NAMES: { NORMALIZE: 'normalize' }, getQueue: vi.fn() }));

const page = JSON.parse(readFileSync(resolve(process.cwd(), '../contracts/content-reset-page-v1-fixtures.json'), 'utf8')).page;
function data() {
  return { tenantId: 'tenant', sourceRunRequestId: page.campaignId, sourceId: page.branchId, sourceType: 'REDDIT', fetchJobId: 'fetch', sourceRunPageId: 'initial', sourceRunBatchId: 'batch-0', contentResetReplay: page,
    rawItems: [{ externalId: 'item', rawData: {}, fetchedAt: '2026-09-29T00:00:00Z', upstreamObservationId: page.pageId, upstreamFingerprint: 'a'.repeat(64) }],
    sourceRun: { contractVersion: 'source-run/v1', tenantId: 'tenant', sourceRunRequestId: page.campaignId, sourceRunAttemptId: page.revisionId, executionUnitId: page.pageId, contentSourceId: page.branchId,
      attemptFenceToken: '00000000-0000-4000-8000-000000000005', executionLeaseToken: '00000000-0000-4000-8000-000000000006', executionLeaseExpiresAt: '2099-01-01T00:00:00Z', unitJobId: `source-unit:${'a'.repeat(64)}` } };
}

describe('reset normalize admission', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['source', 'page', 'observation', 'fingerprint', 'context', 'legacy'])('rejects %s drift before any effect', async (field) => {
    const input: Record<string, any> = data();
    if (field === 'source') input.sourceType = 'PODCAST';
    if (field === 'page') input.sourceRunPageId = 'next';
    if (field === 'observation') input.rawItems[0].upstreamObservationId = undefined;
    if (field === 'fingerprint') input.rawItems[0].upstreamFingerprint = 'bad';
    if (field === 'context') input.contentResetReplay = { ...page, specHash: 'b'.repeat(64) };
    if (field === 'legacy') input.sourceRun = undefined;
    const { createNormalizeWorker } = await import('../../src/workers/normalize.worker.js');
    const worker = createNormalizeWorker() as unknown as { processor: (job: unknown, logger: unknown) => Promise<void> };
    await expect(worker.processor({ id: 'job', data: input }, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })).rejects.toThrow();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.normalize).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('uses the durable reference for an already staged instance without another upsert', async () => {
    const stop = vi.fn();
    mocks.heartbeat.mockReturnValue({ assertCurrent: vi.fn(), stop });
    mocks.normalize.mockReturnValue({ type: 'NEWS', title: 'A complete news title', bodyText: 'A complete article body. '.repeat(10), metadata: {}, idempotencyKey: 'key' });
    mocks.dedup.mockResolvedValue({ isDuplicate: false });
    mocks.grant.mockResolvedValue({ grantKind: 'existing_instance', referenceId: page.pageId, existingContentItemId: page.branchId, sourceObservationId: page.pageId });
    const { createNormalizeWorker } = await import('../../src/workers/normalize.worker.js');
    const worker = createNormalizeWorker() as unknown as { processor: (job: unknown, logger: unknown) => Promise<void> };
    await worker.processor({ id: 'job', data: data() }, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
    expect(mocks.begin).toHaveBeenCalledOnce();
    expect(mocks.grant).toHaveBeenCalledOnce();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.disposition).toHaveBeenCalledWith(expect.objectContaining({ disposition: 'materialized', contentItemId: page.branchId, observationId: page.pageId, unitId: page.pageId }), 'job');
    expect(mocks.receipt).toHaveBeenLastCalledWith(expect.objectContaining({ eventType: 'normalize_terminal', outcome: 'no_change', payload: expect.objectContaining({ processed: 0, duplicates: 1, cms_upserted: 1, failed: 0 }) }));
    expect(stop).toHaveBeenCalledOnce();
  });
});
