import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const queues = new Map<string, { add: ReturnType<typeof vi.fn>; getRepeatableJobs?: ReturnType<typeof vi.fn>; removeRepeatableByKey?: ReturnType<typeof vi.fn> }>()
  const cmsClient = {
    claimNextSourceRun: vi.fn(), claimUnitAdoptionAction: vi.fn(), prepareUnitAdoptionAction: vi.fn(), acknowledgeUnitAdoptionAction: vi.fn(),
    acceptSourceRunUnit: vi.fn(), authorizeSourceRunUnit: vi.fn(),
  }
  return { queues, cmsClient, enqueueSourceRunReceipt: vi.fn(), buildSourceRunReceipt: vi.fn((value) => value), createWorker: vi.fn((definition) => definition) }
})

vi.mock('../../src/queues/index.js', () => ({
  QUEUE_NAMES: { SOURCE_RUN_DISPATCH: 'source-run-dispatch-queue', FETCH: 'fetch-queue' },
  getQueue: vi.fn((name: string) => mocks.queues.get(name)),
}))
vi.mock('../../src/cms/client.js', () => ({ cmsClient: mocks.cmsClient }))
vi.mock('../../src/services/lifecycle-receipts.js', () => ({ enqueueSourceRunReceipt: mocks.enqueueSourceRunReceipt, buildSourceRunReceipt: mocks.buildSourceRunReceipt }))
vi.mock('../../src/workers/base-worker.js', () => ({ createWorker: mocks.createWorker }))
vi.mock('../../src/observability/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))

const ids = {
  request: '11111111-1111-4111-8111-111111111111', attempt: '22222222-2222-4222-8222-222222222222', root: '33333333-3333-4333-8333-333333333333',
  page: '44444444-4444-4444-8444-444444444444', fence: '55555555-5555-4555-8555-555555555555', lease: '66666666-6666-4666-8666-666666666666',
}
const claim = {
  request: { id: ids.request, tenant_id: 'tenant-a', source_id: '77777777-7777-4777-8777-777777777777', lane: 'media', purpose: 'circulation', correlation_id: 'media:test', item_cap: 3, byte_cap: 4096, provider_call_cap: 1, workload_cap: 4, metadata: {} },
  attempt: { id: ids.attempt, fence_token: ids.fence },
  unit: { id: ids.root, job_id: 'source-unit:root', attempt_fence_token: ids.fence },
  source: { id: '77777777-7777-4777-8777-777777777777', type: 'PODCAST', name: 'Tenant A podcast', url: 'https://example.test/feed', settings: {}, fetch_interval_minutes: 30 },
} as const

describe('source-run dispatch worker', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.queues.clear()
    mocks.queues.set('source-run-dispatch-queue', { add: vi.fn().mockResolvedValue({ id: 'queued-root' }) })
    mocks.queues.set('fetch-queue', { add: vi.fn().mockResolvedValue({ id: 'queued-page' }) })
    mocks.cmsClient.claimUnitAdoptionAction.mockResolvedValue(null)
    mocks.cmsClient.claimNextSourceRun.mockResolvedValue(claim)
    mocks.cmsClient.acceptSourceRunUnit.mockResolvedValue({ execution_lease_token: ids.lease, execution_lease_expires_at: '2099-01-01T00:00:00.000Z' })
    mocks.cmsClient.authorizeSourceRunUnit.mockResolvedValue({ id: ids.page, job_id: 'source-unit:page', attempt_fence_token: ids.fence })
    mocks.enqueueSourceRunReceipt.mockResolvedValue('receipt-job')
  })

  it('claims only CMS-selected work and preserves the deterministic root identity', async () => {
    const { createSourceRunDispatchWorker } = await import('../../src/workers/source-run-dispatch.worker.js')
    const sourceRunDispatchWorker = createSourceRunDispatchWorker() as unknown as { processor: (job: unknown, logger: unknown) => Promise<void> }
    await sourceRunDispatchWorker.processor({ data: { trigger: 'auto' }, id: 'tick-1' } as never, { debug: vi.fn() })
    expect(mocks.cmsClient.claimNextSourceRun).toHaveBeenCalledWith('tick-1')
    expect(mocks.queues.get('source-run-dispatch-queue')!.add).toHaveBeenCalledWith('source-run-coordinator', expect.objectContaining({ claim }), expect.objectContaining({ jobId: 'source-unit-root' }))
  })

  it('uses CMS-authorized page identity and carries the complete fenced envelope', async () => {
    const { createSourceRunDispatchWorker } = await import('../../src/workers/source-run-dispatch.worker.js')
    const sourceRunDispatchWorker = createSourceRunDispatchWorker() as unknown as { processor: (job: unknown, logger: unknown) => Promise<void> }
    await sourceRunDispatchWorker.processor({ data: { trigger: 'auto', claim }, id: 'coordinator-1' } as never, { debug: vi.fn() })
    expect(mocks.cmsClient.acceptSourceRunUnit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', requestId: ids.request, attemptId: ids.attempt, unitId: ids.root, unitJobId: claim.unit.job_id, attemptFenceToken: ids.fence }), 'coordinator-1')
    expect(mocks.cmsClient.authorizeSourceRunUnit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', requestId: ids.request, attemptId: ids.attempt, parentUnitId: ids.root, unitType: 'fetch_page', pageId: 'initial' }), 'coordinator-1')
    const fetchCall = mocks.queues.get('fetch-queue')!.add.mock.calls[0]
    expect(fetchCall[0]).toBe('source-run-fetch-page')
    expect(fetchCall[1]).toEqual(expect.objectContaining({ tenantId: 'tenant-a', sourceRunRequestId: ids.request, sourceRunCoordinatorUnitId: ids.root, sourceRunPageId: 'initial', sourceRun: expect.objectContaining({ executionUnitId: ids.page, attemptFenceToken: ids.fence, executionLeaseToken: ids.lease }) }))
    expect(fetchCall[1].config.settings).toEqual(expect.objectContaining({
      max_results: 3,
      min_duration_minutes: 4.5,
    }))
    expect(fetchCall[2]).toEqual(expect.objectContaining({ jobId: 'source-unit-page' }))
    expect(mocks.enqueueSourceRunReceipt).toHaveBeenCalledTimes(1)
    const dispatchReceipt = mocks.buildSourceRunReceipt.mock.calls[0][0]
    expect(dispatchReceipt).toEqual(expect.objectContaining({
      stage: 'dispatch',
      eventType: 'accepted',
    }))
    expect(dispatchReceipt.pageId).toBeUndefined()
  })

  it('fails closed when the CMS-authorized downstream queue is unavailable', async () => {
    mocks.queues.delete('fetch-queue')
    const { createSourceRunDispatchWorker } = await import('../../src/workers/source-run-dispatch.worker.js')
    const sourceRunDispatchWorker = createSourceRunDispatchWorker() as unknown as { processor: (job: unknown, logger: unknown) => Promise<void> }
    await expect(sourceRunDispatchWorker.processor({ data: { trigger: 'auto', claim }, id: 'coordinator-2' } as never, { debug: vi.fn() })).rejects.toThrow('fetch queue is unavailable')
    expect(mocks.enqueueSourceRunReceipt).not.toHaveBeenCalled()
  })

  it('keeps the polling tick below claimed coordinator work', async () => {
    const queue = mocks.queues.get('source-run-dispatch-queue')!
    queue.getRepeatableJobs = vi.fn().mockResolvedValue([])
    queue.removeRepeatableByKey = vi.fn().mockResolvedValue(undefined)
    const { syncSourceRunDispatchSweeper } = await import('../../src/workers/source-run-dispatch.worker.js')

    await syncSourceRunDispatchSweeper()

    expect(queue.add).toHaveBeenCalledWith(
      'source-run-dispatch-repeatable',
      { trigger: 'auto' },
      expect.objectContaining({ priority: 100, attempts: 1 }),
    )
  })
})
