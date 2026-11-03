import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(definition => definition),
  reserveLocalScratch: vi.fn(),
  downloadStorageObject: vi.fn(),
  objectExists: vi.fn(),
  getMediaInfo: vi.fn(),
  withResourceLease: vi.fn(),
  removeLease: vi.fn(),
  cms: Object.fromEntries(['beginContentStage', 'heartbeatContentStage', 'reportAtomizationRun',
    'getAtomizationInput', 'resolveAtomizationGeneration', 'listAtomizationChapterUnits',
    'deferContentStage', 'failContentStage', 'uncertainContentStage', 'resolveMediaDeliveryPolicy',
    'claimAtomizationChapterUnit', 'transitionAtomizationChapterUnit'].map(name => [name, vi.fn()])),
}));
vi.mock('../../src/workers/base-worker.js', () => ({ createWorker: mocks.createWorker }));
vi.mock('../../src/runtime/local-reservations.js', () => ({ reserveLocalScratch: mocks.reserveLocalScratch }));
vi.mock('../../src/media/storage-downloader.js', () => ({ downloadStorageObject: mocks.downloadStorageObject }));
vi.mock('../../src/media/downloader.js', () => ({ cleanupTempFile: vi.fn() }));
vi.mock('../../src/media/transcoder.js', () => ({ getMediaInfo: mocks.getMediaInfo }));
vi.mock('../../src/runtime/resource-admission.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/runtime/resource-admission.js')>(),
  withResourceLease: mocks.withResourceLease,
}));
vi.mock('../../src/storage/client.js', () => ({ objectExists: mocks.objectExists }));
vi.mock('../../src/cms/client.js', () => ({
  cmsClient: mocks.cms,
  CMSRequestError: class extends Error {},
  contentStageCorrelation: (claim: unknown) => claim,
  isStaleContentStageDeliveryError: () => false,
}));
vi.mock('../../src/workers/content-stage-lease.js', () => ({
  startContentStageLeaseHeartbeats: () => ({ signal: new AbortController().signal, addLease: vi.fn(), removeLease: mocks.removeLease, stop: vi.fn() }),
}));
import { createAtomizationWorker } from '../../src/workers/atomization.worker.js';
import { ResourceDeferredError } from '../../src/runtime/resource-admission.js';

describe('durable atomization scratch admission', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createWorker.mockImplementation(definition => definition);
    mocks.cms.heartbeatContentStage.mockResolvedValue({ lease_expires_at: new Date(Date.now() + 60_000).toISOString() });
    mocks.cms.reportAtomizationRun.mockResolvedValue({ run_id: 'run' });
    mocks.cms.getAtomizationInput.mockResolvedValue({
      item: { id: 'episode', tenant_id: 'default', duration_sec: 3000, source_manifest_id: 'manifest', source_manifest_key: 'source.m4a', source_manifest_url: 'http://127.0.0.1:59000/bucket/source.m4a' },
      policy: { chaptering_enabled: true, atomization_min_parent_seconds: 2400 },
      transcript: { full_text: 'Transcript' }, segments: [{ start_ms: 0, end_ms: 3000000, text: 'Transcript' }],
    });
    mocks.cms.resolveAtomizationGeneration.mockResolvedValue({ generation: { id: 'saved-generation', plan: [{ title: 'Chapter', start_ms: 0, end_ms: 3000000 }] } });
    mocks.cms.listAtomizationChapterUnits.mockResolvedValue({ units: [] });
    mocks.cms.transitionAtomizationChapterUnit.mockResolvedValue({});
  });

  it('defers before media effects, preserving the saved generation and failure budget', async () => {
    const error = new ResourceDeferredError('download_io');
    mocks.reserveLocalScratch.mockRejectedValue(error);
    const worker = createAtomizationWorker() as unknown as { processor: Function };
    const claim = { request_id: 'request', attempt_id: 'attempt', fence_token: 'fence' };
    await worker.processor({ id: 'delivery', data: { contentItemId: 'episode', contentStageClaim: claim } }, { info: vi.fn(), warn: vi.fn() }, new AbortController().signal);
    expect(mocks.cms.deferContentStage).toHaveBeenCalledWith(claim, 30, error.message, 'delivery');
    expect(mocks.cms.uncertainContentStage).not.toHaveBeenCalled();
    expect(mocks.cms.failContentStage).not.toHaveBeenCalled();
    expect(mocks.downloadStorageObject).not.toHaveBeenCalled();
    expect(mocks.removeLease).toHaveBeenCalledWith('content_stage');
    expect(mocks.cms.reportAtomizationRun).toHaveBeenLastCalledWith('episode', expect.objectContaining({ status: 'queued', phase: 'cutting' }), 'delivery', expect.anything());
  });

  it('downloads the manifest key and reconciles an active unit instead of declaring it effect-free', async () => {
    const release = vi.fn();
    mocks.reserveLocalScratch.mockResolvedValue({ sourceDir: '/tmp/source', outputDir: '/tmp/output', release });
    mocks.objectExists.mockResolvedValue(true);
    mocks.downloadStorageObject.mockResolvedValue({ filePath: '/tmp/source/episode.m4a' });
    mocks.getMediaInfo.mockResolvedValue({ visualAvailable: false });
    mocks.cms.resolveMediaDeliveryPolicy.mockResolvedValue({ policy: {} });
    mocks.cms.claimAtomizationChapterUnit.mockResolvedValue({ unit: {
      id: 'unit', unit_index: 0, claim_token: 'unit-token', fence_token: 'unit-fence',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(), attempt_count: 1,
    } });
    const error = new ResourceDeferredError('software_encode');
    mocks.withResourceLease.mockRejectedValue(error);
    const worker = createAtomizationWorker() as unknown as { processor: Function };
    const claim = { request_id: 'request', attempt_id: 'attempt', fence_token: 'fence' };
    await expect(worker.processor({ id: 'delivery', data: { contentItemId: 'episode', contentStageClaim: claim } }, { info: vi.fn(), warn: vi.fn() }, new AbortController().signal)).rejects.toThrow(error);
    expect(mocks.downloadStorageObject).toHaveBeenCalledWith('source.m4a', 'primary', 'episode_atomize', 'm4a', expect.any(AbortSignal), '/tmp/source');
    expect(mocks.cms.transitionAtomizationChapterUnit).toHaveBeenCalledWith('unit', 'uncertain', expect.objectContaining({ claim_token: 'unit-token', fence_token: 'unit-fence' }), 'delivery');
    expect(mocks.cms.uncertainContentStage).toHaveBeenCalledWith(claim, error.message, 'delivery');
    expect(mocks.cms.deferContentStage).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
