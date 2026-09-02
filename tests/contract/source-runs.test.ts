import { describe, expect, it } from 'vitest'

import {
  SOURCE_RUN_CONTRACT_VERSION,
  sourceRunExecutionEnvelopeSchema,
  sourceRunReceiptCapability,
  sourceRunReceiptPayloadDigest,
  sourceRunManifestChildDigest,
  sourceRunQueueJobId,
  sourceRunVerificationClaimSchema,
  sourceRunReceiptSchema,
  sourceRunTerminalOutcomeCategory,
} from '../../src/contracts/source-runs.js'

const envelope = {
  contractVersion: SOURCE_RUN_CONTRACT_VERSION,
  tenantId: 'tenant-a',
  sourceRunRequestId: '11111111-1111-4111-8111-111111111111',
  sourceRunAttemptId: '22222222-2222-4222-8222-222222222222',
  executionUnitId: '33333333-3333-4333-8333-333333333333',
  contentSourceId: '44444444-4444-4444-8444-444444444444',
  attemptFenceToken: '55555555-5555-4555-8555-555555555555',
  executionLeaseToken: '66666666-6666-4666-8666-666666666666',
  executionLeaseExpiresAt: '2026-08-09T12:30:00Z',
  unitJobId: 'source-unit:fixture',
}

describe('source-run/v1 contract', () => {
  it('requires every execution identity and rejects unknown fields', () => {
    expect(sourceRunExecutionEnvelopeSchema.safeParse(envelope).success).toBe(true)
    expect(sourceRunExecutionEnvelopeSchema.safeParse({ ...envelope, unknown: true }).success).toBe(false)
    expect(sourceRunExecutionEnvelopeSchema.safeParse({ ...envelope, tenantId: '' }).success).toBe(false)
  })

  it('binds the receipt digest to the exact serialized payload', () => {
    const serializedPayload = '{"count":1,"kind":"provider_page"}'
    const receipt = {
      ...envelope,
      producerEventKey: 'producer-event-1',
      schemaVersion: SOURCE_RUN_CONTRACT_VERSION,
      producer: 'aggregation',
      stage: 'fetch',
      eventType: 'provider_page',
      outcome: 'observed',
      sequence: 1,
      finalPage: false,
      producedAt: '2026-08-09T12:00:00Z',
      payload: JSON.parse(serializedPayload),
      payloadDigest: sourceRunReceiptPayloadDigest(serializedPayload),
    }
    expect(sourceRunReceiptSchema.safeParse(receipt).success).toBe(true)
    expect(sourceRunReceiptSchema.safeParse({ ...receipt, extra: true }).success).toBe(false)
  })

  it('freezes the receipt and terminal-outcome capability matrices', () => {
    expect(sourceRunReceiptCapability.fetch).toContain('provider_page')
    expect(sourceRunReceiptCapability.delivery).not.toContain('provider_page')
    expect(sourceRunTerminalOutcomeCategory.no_change).toBe('succeeded')
    expect(sourceRunTerminalOutcomeCategory.unknown).toBe('verification_required')
  })

  it('uses the CMS-compatible deterministic digest for a fetch-page child declaration', () => {
    expect(sourceRunManifestChildDigest(['normalize:page-a:batch-2', 'normalize:page-a:batch-1']))
      .toBe(sourceRunManifestChildDigest(['normalize:page-a:batch-1', 'normalize:page-a:batch-2']))
    expect(() => sourceRunManifestChildDigest([''])).toThrow('non-empty')
  })

  it('encodes CMS unit identities as BullMQ-safe custom job IDs', () => {
    expect(sourceRunQueueJobId('source-unit:abc')).toBe('source-unit-abc')
    expect(sourceRunQueueJobId('source-unit:abc')).not.toContain(':')
    expect(() => sourceRunQueueJobId('  ')).toThrow('requires a CMS unit job ID')
  })

  it('accepts only a CMS-selected, fenced verification task', () => {
    const claim = {
      id: '77777777-7777-4777-8777-777777777777', tenant_id: 'tenant-a',
      source_run_request_id: envelope.sourceRunRequestId, source_run_attempt_id: envelope.sourceRunAttemptId,
      execution_unit_id: envelope.executionUnitId, content_source_id: envelope.contentSourceId,
      stage: 'normalize_batch', claim_token: envelope.executionLeaseToken,
      claim_expires_at: '2026-08-09T12:30:00Z',
    }
    expect(sourceRunVerificationClaimSchema.safeParse(claim).success).toBe(true)
    expect(sourceRunVerificationClaimSchema.safeParse({ ...claim, tenant_id: '' }).success).toBe(false)
    // CMS may select the supervisory coordinator only for its bounded
    // downstream-content readback; Aggregation still cannot choose it.
    expect(sourceRunVerificationClaimSchema.safeParse({ ...claim, stage: 'coordinator' }).success).toBe(true)
    expect(sourceRunVerificationClaimSchema.safeParse({ ...claim, stage: 'delivery' }).success).toBe(true)
    expect(sourceRunVerificationClaimSchema.safeParse({ ...claim, stage: 'arbitrary' }).success).toBe(false)
  })
})
