/**
 * Checked-in counterpart of CMS source-run/v1. Aggregation treats these as
 * protocol data only: CMS remains the authority for admission, leases, and
 * the manifest. Logical queue identities are deterministic and never include
 * Date.now(), a random retry suffix, or an implicit tenant.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

export const SOURCE_RUN_CONTRACT_VERSION = 'source-run/v1' as const

export type SourceRunRequestState =
  | 'requested'
  | 'accepted'
  | 'running'
  | 'verification_required'
  | 'completed'
  | 'succeeded'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'expired'

export type SourceRunAttemptState =
  | 'authorized'
  | 'claimed'
  | 'running'
  | 'verification_required'
  | 'succeeded'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'expired'

export type SourceRunExecutionUnitType = 'coordinator' | 'fetch_page' | 'normalize_batch'
export type SourceRunExecutionUnitState =
  | 'authorized'
  | 'accepted'
  | 'running'
  | 'verification_required'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'

export type SourceRunReceiptVerdict = 'present' | 'absent' | 'unknown'
export type SourceRunManifestState = 'open' | 'sealing' | 'sealed'
export type SourceRunReceiptStage = 'dispatch' | 'fetch' | 'normalize' | 'delivery'
export type SourceRunReceiptEvent =
  | 'accepted'
  | 'execution_started'
  | 'provider_request_started'
  | 'provider_page'
  | 'provider_terminal'
  | 'normalize_scheduled'
  | 'normalize_terminal'
  | 'finalization'
  | 'failed'
  | 'cancelled'
  | 'dlq'
export type SourceRunOutcome =
  | 'new_items'
  | 'no_change'
  | 'upstream_change_deferred'
  | 'observation_blocked_by_intake'
  | 'configuration_blocked'
  | 'partial'
  | 'provider_failed'
  | 'cancelled'
  | 'dead_lettered'
  | 'unknown'

export const sourceRunReceiptCapability: Readonly<Record<SourceRunReceiptStage, readonly SourceRunReceiptEvent[]>> = {
  dispatch: ['accepted', 'failed', 'cancelled'],
  fetch: ['execution_started', 'provider_request_started', 'provider_page', 'provider_terminal', 'failed', 'cancelled', 'dlq'],
  normalize: ['normalize_scheduled', 'normalize_terminal', 'failed', 'cancelled', 'dlq'],
  delivery: ['finalization', 'failed'],
}

export const sourceRunTerminalOutcomeCategory: Readonly<Record<SourceRunOutcome, SourceRunRequestState>> = {
  new_items: 'succeeded',
  no_change: 'succeeded',
  upstream_change_deferred: 'succeeded',
  observation_blocked_by_intake: 'blocked',
  configuration_blocked: 'blocked',
  partial: 'partial',
  provider_failed: 'failed',
  cancelled: 'cancelled',
  dead_lettered: 'failed',
  unknown: 'verification_required',
}

export const sourceRunExecutionEnvelopeSchema = z.object({
  contractVersion: z.literal(SOURCE_RUN_CONTRACT_VERSION),
  tenantId: z.string().trim().min(1).max(64),
  sourceRunRequestId: z.string().uuid(),
  sourceRunAttemptId: z.string().uuid(),
  executionUnitId: z.string().uuid(),
  contentSourceId: z.string().uuid(),
  attemptFenceToken: z.string().uuid(),
  executionLeaseToken: z.string().uuid(),
  executionLeaseExpiresAt: z.string().datetime({ offset: true }),
  unitJobId: z.string().trim().min(1).max(255),
}).strict()

export type SourceRunExecutionEnvelope = z.infer<typeof sourceRunExecutionEnvelopeSchema>

export const sourceRunReceiptSchema = z.object({
  ...sourceRunExecutionEnvelopeSchema.shape,
  producerEventKey: z.string().trim().min(1).max(255),
  schemaVersion: z.literal(SOURCE_RUN_CONTRACT_VERSION),
  producer: z.enum(['aggregation', 'enrichment', 'media']),
  stage: z.string().trim().min(1).max(48),
  eventType: z.string().trim().min(1).max(64),
  outcome: z.string().trim().min(1).max(48),
  sequence: z.number().int().nonnegative(),
  pageId: z.string().trim().min(1).max(128).optional(),
  batchId: z.string().trim().min(1).max(128).optional(),
  finalPage: z.boolean(),
  causationId: z.string().trim().min(1).max(255).optional(),
  producedAt: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export type SourceRunReceipt = z.infer<typeof sourceRunReceiptSchema>

export const sourceRunDispatchClaimSchema = z.object({
  request: z.object({
    id: z.string().uuid(),
    tenant_id: z.string().trim().min(1).max(64),
    source_id: z.string().uuid(),
    lane: z.enum(['news', 'media']),
    purpose: z.string().trim().min(1).max(48),
    correlation_id: z.string().trim().min(1).max(255),
	metadata: z.record(z.string(), z.unknown()),
	item_cap: z.number().int().nonnegative().max(1000),
	byte_cap: z.number().int().positive().max(536870912),
	provider_call_cap: z.number().int().positive().max(100),
	workload_cap: z.number().int().positive().max(1100),
  }).strict(),
  source: z.object({
    id: z.string().uuid(),
    type: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(255),
    url: z.string().trim().min(1),
    settings: z.record(z.string(), z.unknown()),
    fetch_interval_minutes: z.number().int().positive(),
    source_config_version: z.number().int().positive(),
  }).strict(),
  attempt: z.object({
    id: z.string().uuid(),
    fence_token: z.string().uuid(),
    dispatcher_token: z.string().uuid(),
    dispatcher_lease_expires_at: z.string().datetime({ offset: true }),
  }).strict(),
  unit: z.object({
    id: z.string().uuid(),
    job_id: z.string().regex(/^source-unit:[a-f0-9]{64}$/),
    execution_lease_token: z.string().uuid(),
    execution_lease_expires_at: z.string().datetime({ offset: true }),
    unit_type: z.literal('coordinator'),
  }).strict(),
}).strict()

export type SourceRunDispatchClaim = z.infer<typeof sourceRunDispatchClaimSchema>

export const sourceRunUnitLeaseSchema = z.object({
  execution_lease_token: z.string().uuid(),
  execution_lease_expires_at: z.string().datetime({ offset: true }),
  state: z.literal('accepted'),
  reused: z.boolean(),
}).strict()

export type SourceRunUnitLease = z.infer<typeof sourceRunUnitLeaseSchema>

export const sourceRunAuthorizedUnitSchema = z.object({
  id: z.string().uuid(),
  job_id: z.string().regex(/^source-unit:[a-f0-9]{64}$/),
  attempt_fence_token: z.string().uuid(),
  state: z.literal('authorized'),
  duplicate: z.boolean(),
}).strict()

export type SourceRunAuthorizedUnit = z.infer<typeof sourceRunAuthorizedUnitSchema>

export const sourceRunVerificationClaimSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().trim().min(1).max(64),
  source_run_request_id: z.string().uuid(),
  source_run_attempt_id: z.string().uuid().nullable(),
  execution_unit_id: z.string().uuid().nullable(),
  content_source_id: z.string().uuid(),
  stage: z.enum(['coordinator', 'fetch_page', 'normalize_batch', 'delivery']),
  claim_token: z.string().uuid(),
  claim_expires_at: z.string().datetime({ offset: true }),
}).strict()

export type SourceRunVerificationClaim = z.infer<typeof sourceRunVerificationClaimSchema>

export const sourceRunVerificationObservationSchema = z.object({
  id: z.string().uuid(),
  duplicate: z.boolean(),
  verdict: z.enum(['present', 'absent', 'unknown']),
  evidence_snapshot: z.string().trim().min(1).max(255),
}).strict()

// The digest is over the exact JSON bytes sent as payload. Producers should
// use JSON.stringify once, retain those bytes for redelivery, and hash the
// same bytes; CMS never rewrites a receipt payload before verifying it.
export function sourceRunReceiptPayloadDigest(serializedPayload: string): string {
  return createHash('sha256').update(serializedPayload, 'utf8').digest('hex')
}

// CMS computes the same digest while sealing a fetch-page declaration. This
// covers exact unit keys in stable order, never queue IDs or raw provider data.
export function sourceRunManifestChildDigest(unitKeys: readonly string[]): string {
  const normalized = [...unitKeys].map((key) => key.trim()).sort()
  if (normalized.some((key) => !key)) throw new Error('manifest child keys must be non-empty')
  return createHash('sha256').update(normalized.join('\n'), 'utf8').digest('hex')
}

export function deterministicSourceRunUnitJobId(input: Pick<SourceRunExecutionEnvelope, 'tenantId' | 'sourceRunRequestId' | 'sourceRunAttemptId' | 'executionUnitId' | 'attemptFenceToken'>): string {
  const values = [input.tenantId, input.sourceRunRequestId, input.sourceRunAttemptId, input.executionUnitId, input.attemptFenceToken]
  if (values.some((value) => !value || !value.trim())) {
    throw new Error('deterministic source-run job ID requires explicit tenant, request, attempt, unit, and fence')
  }
  return `source-unit:${createHash('sha256').update(values.join('\n')).digest('hex')}`
}

// CMS unit job IDs are protocol identities and intentionally use a colon.
// BullMQ reserves colons in custom job IDs, so queue identity must use this
// lossless, deterministic transport encoding while the fenced CMS envelope
// continues carrying the original protocol value.
export function sourceRunQueueJobId(unitJobId: string): string {
  const normalized = unitJobId.trim()
  if (!normalized) throw new Error('source-run queue job ID requires a CMS unit job ID')
  return normalized.replaceAll(':', '-')
}

export function canBeginSourceRunEffect(envelope: SourceRunExecutionEnvelope, now = new Date()): boolean {
  return Boolean(
    envelope.tenantId.trim() &&
      envelope.sourceRunRequestId.trim() &&
      envelope.sourceRunAttemptId.trim() &&
      envelope.executionUnitId.trim() &&
      envelope.attemptFenceToken.trim() &&
      envelope.executionLeaseToken.trim() &&
      envelope.unitJobId.trim() &&
      new Date(envelope.executionLeaseExpiresAt).getTime() > now.getTime(),
  )
}
