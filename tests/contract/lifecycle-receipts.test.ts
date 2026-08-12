import { describe, expect, it } from 'vitest'
import { buildSourceRunReceipt, deterministicReceiptEventKey } from '../../src/services/lifecycle-receipts.js'
import { SOURCE_RUN_CONTRACT_VERSION } from '../../src/contracts/source-runs.js'

const envelope = {
  contractVersion: SOURCE_RUN_CONTRACT_VERSION,
  tenantId: 'tenant-a',
  sourceRunRequestId: '11111111-1111-4111-8111-111111111111',
  sourceRunAttemptId: '22222222-2222-4222-8222-222222222222',
  executionUnitId: '33333333-3333-4333-8333-333333333333',
  contentSourceId: '44444444-4444-4444-8444-444444444444',
  attemptFenceToken: '55555555-5555-4555-8555-555555555555',
  executionLeaseToken: '66666666-6666-4666-8666-666666666666',
  executionLeaseExpiresAt: '2026-08-09T12:05:00.000Z',
  unitJobId: 'source-unit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const

describe('source-run lifecycle receipts', () => {
  it('binds a stable event key and exact payload digest to one unit effect', () => {
    const input = { envelope, stage: 'fetch' as const, eventType: 'provider_terminal' as const, outcome: 'no_change' as const, sequence: 2, payload: { upstream_count: 0 }, producedAt: '2026-08-09T12:01:00.000Z' }
    const receipt = buildSourceRunReceipt(input)
    expect(receipt.producerEventKey).toBe(deterministicReceiptEventKey(input))
    expect(receipt.payloadDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.tenantId).toBe('tenant-a')
  })

  it('changes the producer event identity when the immutable effect evidence changes', () => {
    const base = { envelope, stage: 'fetch' as const, eventType: 'provider_page' as const, outcome: 'new_items' as const, sequence: 1, payload: { count: 1 } }
    expect(deterministicReceiptEventKey(base)).not.toBe(deterministicReceiptEventKey({ ...base, payload: { count: 2 } }))
    expect(deterministicReceiptEventKey(base)).not.toBe(deterministicReceiptEventKey({ ...base, sequence: 2 }))
  })
})
