import { describe, expect, it, vi } from 'vitest'
import { startSourceRunLeaseHeartbeat } from '../../src/services/source-run-lease.js'
import { SOURCE_RUN_CONTRACT_VERSION } from '../../src/contracts/source-runs.js'

const envelope = {
  contractVersion: SOURCE_RUN_CONTRACT_VERSION,
  tenantId: 'tenant-a', sourceRunRequestId: '11111111-1111-4111-8111-111111111111',
  sourceRunAttemptId: '22222222-2222-4222-8222-222222222222', executionUnitId: '33333333-3333-4333-8333-333333333333',
  contentSourceId: '44444444-4444-4444-8444-444444444444', attemptFenceToken: '55555555-5555-4555-8555-555555555555',
  executionLeaseToken: '66666666-6666-4666-8666-666666666666', executionLeaseExpiresAt: '2099-08-09T12:05:00.000Z',
  unitJobId: 'source-unit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const

describe('source-run lease heartbeat', () => {
  it('keeps the CMS-confirmed expiry and stops its timer', async () => {
    const renew = vi.fn().mockResolvedValue({ executionLeaseExpiresAt: '2099-08-09T12:06:00.000Z' })
    const heartbeat = startSourceRunLeaseHeartbeat(envelope, { intervalMs: 1_000, renew })
    await Promise.resolve()
    heartbeat.assertCurrent()
    expect(heartbeat.expiresAt()).toBe('2099-08-09T12:06:00.000Z')
    heartbeat.stop()
  })

  it('blocks a later effect boundary after CMS rejects renewal', async () => {
    const heartbeat = startSourceRunLeaseHeartbeat(envelope, { intervalMs: 1_000, renew: vi.fn().mockRejectedValue(new Error('stale lease')) })
    await Promise.resolve()
    expect(() => heartbeat.assertCurrent()).toThrow('stale lease')
    heartbeat.stop()
  })
})
