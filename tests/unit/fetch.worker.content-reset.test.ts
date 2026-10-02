import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchResult } from '../../src/fetchers/types.js';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), receipt: vi.fn(), begin: vi.fn(), freeze: vi.fn(), authorize: vi.fn(), accept: vi.fn(), observations: vi.fn(),
  normalizeAdd: vi.fn(), fetchAdd: vi.fn(),
}));
vi.mock('../../src/workers/base-worker.js', () => ({ createWorker: (definition: unknown) => definition }));
vi.mock('../../src/fetchers/index.js', () => ({ fetchFromSource: mocks.fetch }));
vi.mock('../../src/cms/client.js', () => ({ cmsClient: {
  beginSourceRunUnit: mocks.begin, freezeSourceRunPage: mocks.freeze,
  authorizeSourceRunUnit: mocks.authorize, acceptSourceRunUnit: mocks.accept,
  recordSourceRunUpstreamObservations: mocks.observations,
} }));
vi.mock('../../src/services/lifecycle-receipts.js', () => ({ buildSourceRunReceipt: (input: unknown) => input, enqueueSourceRunReceipt: mocks.receipt }));
vi.mock('../../src/services/source-run-lease.js', () => ({ startSourceRunLeaseHeartbeat: () => ({ assertCurrent() {}, stop() {} }) }));
vi.mock('../../src/queues/index.js', () => ({
  QUEUE_NAMES: { FETCH: 'fetch', NORMALIZE: 'normalize' },
  getQueue: (name: string) => ({ add: name === 'normalize' ? mocks.normalizeAdd : mocks.fetchAdd }),
}));

const page = JSON.parse(readFileSync(resolve(process.cwd(), '../contracts/content-reset-page-v1-fixtures.json'), 'utf8')).page;
const envelope = {
  contractVersion: 'source-run/v1', tenantId: 'tenant-a', sourceRunRequestId: page.campaignId,
  sourceRunAttemptId: page.revisionId, executionUnitId: page.pageId, contentSourceId: page.branchId,
  attemptFenceToken: '00000000-0000-4000-8000-000000000005', executionLeaseToken: '00000000-0000-4000-8000-000000000006',
  executionLeaseExpiresAt: '2099-01-01T00:00:00Z', unitJobId: `source-unit:${'a'.repeat(64)}`,
};
function job() {
  return { id: 'job', data: {
    sourceId: page.branchId, sourceType: 'REDDIT', tenantId: 'tenant-a', sourceRun: envelope,
    sourceRunCoordinatorUnitId: page.revisionId, sourceRunPageId: 'initial', contentResetReplay: page,
    config: { url: 'https://example.test', settings: { max_results: 100, max_bytes: 8388608, max_provider_calls: 1 } },
  } };
}
function result(count: number, more = false): FetchResult {
  return { items: Array.from({ length: count }, (_, i) => ({ externalId: String(i), sourceType: 'REDDIT', url: 'https://example.test/item', title: String(i), publishedAt: '2026-09-15T00:00:00Z', fetchedAt: '2026-09-29T00:00:00Z', metadata: {} })), hasMore: more, cursor: more ? 'opaque-next' : undefined, metadata: { totalFetched: count, skipped: 0, errors: 0 } };
}
async function processJob(input: unknown) {
  const { createFetchWorker } = await import('../../src/workers/fetch.worker.js');
  const worker = createFetchWorker() as unknown as { processor: (job: unknown, logger: unknown) => Promise<void> };
  return worker.processor(input, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
}

describe('Content Reset fetch admission and page effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.begin.mockResolvedValue(undefined); mocks.freeze.mockResolvedValue(undefined); mocks.receipt.mockResolvedValue(undefined);
    mocks.authorize.mockResolvedValue({ id: page.pageId, job_id: `source-unit:${'c'.repeat(64)}`, attempt_fence_token: envelope.attemptFenceToken });
    mocks.accept.mockResolvedValue({ execution_lease_token: envelope.executionLeaseToken, execution_lease_expires_at: envelope.executionLeaseExpiresAt });
    mocks.observations.mockImplementation(async (input) => ({ created: input.items.length, observationIds: Object.fromEntries(input.items.map((item: { upstreamItemId: string }) => [item.upstreamItemId, page.pageId])) }));
    mocks.normalizeAdd.mockResolvedValue(undefined); mocks.fetchAdd.mockResolvedValue(undefined);
  });

  it('refuses changed bounds before beginning any CMS or provider effect', async () => {
    const input = job(); input.data.config.settings.max_results = 101;
    await expect(processJob(input)).rejects.toThrow('immutable contract');
    expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('records overflow as partial without observations, normalize work or cursor continuation', async () => {
    mocks.fetch.mockResolvedValue(result(101, true));
    await processJob(job());
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.freeze).toHaveBeenCalledWith(expect.objectContaining({ declaredChildCount: 0 }), 'job');
    expect(mocks.receipt).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'partial', finalPage: true, payload: expect.objectContaining({ failure_class: 'replay_page_budget_exceeded' }) }));
    expect(mocks.observations).not.toHaveBeenCalled(); expect(mocks.normalizeAdd).not.toHaveBeenCalled(); expect(mocks.fetchAdd).not.toHaveBeenCalled();
  });

  it('admits a complete page and leaves its next opaque cursor for CMS scheduling', async () => {
    mocks.fetch.mockResolvedValue(result(2, true));
    await processJob(job());
    expect(mocks.observations).toHaveBeenCalledTimes(1); expect(mocks.normalizeAdd).toHaveBeenCalledTimes(1);
    expect(mocks.fetchAdd).not.toHaveBeenCalled();
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ unitType: 'normalize_batch' }), 'job');
    expect(mocks.receipt).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'new_items', finalPage: true, payload: expect.objectContaining({ budget_truncated: false, content_reset_replay: expect.objectContaining({ complete: true, next_cursor: 'opaque-next', exhausted: false, admitted: 2 }) }) }));
  });
});
