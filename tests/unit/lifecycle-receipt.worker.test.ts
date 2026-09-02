import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cmsClient: { retainSourceRunReceipt: vi.fn(), deliverSourceRunReceipt: vi.fn(), markSourceRunReceiptDelivered: vi.fn(), claimReceiptRedeliveryAction: vi.fn(), prepareReceiptRedeliveryAction: vi.fn(), completeReceiptRedeliveryAction: vi.fn() },
  createWorker: vi.fn((definition) => definition),
}))

vi.mock('../../src/cms/client.js', () => ({ cmsClient: mocks.cmsClient }))
vi.mock('../../src/workers/base-worker.js', () => ({ createWorker: mocks.createWorker }))
vi.mock('../../src/queues/index.js', () => ({ QUEUE_NAMES: { LIFECYCLE_RECEIPTS: 'lifecycle-receipts-queue' }, getQueue: vi.fn() }))

const receipt = {
  contractVersion: 'source-run/v1', tenantId: 'tenant-a', sourceRunRequestId: '11111111-1111-4111-8111-111111111111', sourceRunAttemptId: '22222222-2222-4222-8222-222222222222',
  executionUnitId: '33333333-3333-4333-8333-333333333333', contentSourceId: '44444444-4444-4444-8444-444444444444', attemptFenceToken: '55555555-5555-4555-8555-555555555555',
  executionLeaseToken: '66666666-6666-4666-8666-666666666666', executionLeaseExpiresAt: '2099-01-01T00:00:00.000Z', unitJobId: 'source-unit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  producerEventKey: 'receipt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', schemaVersion: 'source-run/v1', producer: 'aggregation', stage: 'fetch', eventType: 'provider_terminal', outcome: 'no_change', sequence: 0,
  finalPage: false, producedAt: '2026-08-09T12:00:00.000Z', payload: {}, payloadDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const

describe('lifecycle receipt worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.cmsClient.retainSourceRunReceipt.mockResolvedValue(undefined)
    mocks.cmsClient.deliverSourceRunReceipt.mockResolvedValue(undefined)
    mocks.cmsClient.markSourceRunReceiptDelivered.mockResolvedValue(undefined)
  })

  it('retains, delivers, then marks only the exact receipt as acknowledged', async () => {
    const { createLifecycleReceiptWorker } = await import('../../src/workers/lifecycle-receipt.worker.js')
    const worker = createLifecycleReceiptWorker() as unknown as { processor: (job: unknown) => Promise<void> }
    await worker.processor({ id: 'receipt-job-1', data: { receipt } })
    expect(mocks.cmsClient.retainSourceRunReceipt).toHaveBeenCalledWith(receipt, 'receipt-job-1')
    expect(mocks.cmsClient.deliverSourceRunReceipt).toHaveBeenCalledWith(receipt, 'receipt-job-1')
    expect(mocks.cmsClient.markSourceRunReceiptDelivered).toHaveBeenCalledWith(receipt, 'receipt-job-1')
    expect(mocks.cmsClient.retainSourceRunReceipt.mock.invocationCallOrder[0]).toBeLessThan(mocks.cmsClient.deliverSourceRunReceipt.mock.invocationCallOrder[0])
  })

  it('does not mark a receipt delivered when CMS delivery is unavailable', async () => {
    mocks.cmsClient.deliverSourceRunReceipt.mockRejectedValueOnce(new Error('CMS unavailable'))
    const { createLifecycleReceiptWorker } = await import('../../src/workers/lifecycle-receipt.worker.js')
    const worker = createLifecycleReceiptWorker() as unknown as { processor: (job: unknown) => Promise<void> }
    await expect(worker.processor({ id: 'receipt-job-2', data: { receipt } })).rejects.toThrow('CMS unavailable')
    expect(mocks.cmsClient.markSourceRunReceiptDelivered).not.toHaveBeenCalled()
  })
})
