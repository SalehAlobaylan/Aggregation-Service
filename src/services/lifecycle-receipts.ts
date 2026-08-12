import { createHash } from 'node:crypto';
import { getQueue, QUEUE_NAMES, type LifecycleReceiptJob } from '../queues/index.js';
import {
  SOURCE_RUN_CONTRACT_VERSION,
  sourceRunExecutionEnvelopeSchema,
  sourceRunReceiptPayloadDigest,
  sourceRunReceiptSchema,
  type SourceRunExecutionEnvelope,
  type SourceRunReceipt,
  type SourceRunReceiptEvent,
  type SourceRunReceiptStage,
  type SourceRunOutcome,
} from '../contracts/source-runs.js';

export interface SourceRunReceiptInput {
  envelope: SourceRunExecutionEnvelope;
  stage: SourceRunReceiptStage;
  eventType: SourceRunReceiptEvent;
  outcome: SourceRunOutcome;
  sequence: number;
  payload: Record<string, unknown>;
  pageId?: string;
  batchId?: string;
  finalPage?: boolean;
  causationId?: string;
  producedAt?: string;
}

// Source-run receipts are persisted in BullMQ before delivery. An executor
// therefore never treats a successful provider operation as complete merely
// because an HTTP callback happened to succeed once.
export function buildSourceRunReceipt(input: SourceRunReceiptInput): SourceRunReceipt {
  const envelope = sourceRunExecutionEnvelopeSchema.parse(input.envelope);
  const serializedPayload = JSON.stringify(input.payload);
  const producerEventKey = deterministicReceiptEventKey(input, serializedPayload);
  return sourceRunReceiptSchema.parse({
    ...envelope,
    contractVersion: SOURCE_RUN_CONTRACT_VERSION,
    producerEventKey,
    schemaVersion: SOURCE_RUN_CONTRACT_VERSION,
    producer: 'aggregation',
    stage: input.stage,
    eventType: input.eventType,
    outcome: input.outcome,
    sequence: input.sequence,
    pageId: input.pageId,
    batchId: input.batchId,
    finalPage: input.finalPage ?? false,
    causationId: input.causationId,
    producedAt: input.producedAt ?? new Date().toISOString(),
    payload: input.payload,
    payloadDigest: sourceRunReceiptPayloadDigest(serializedPayload),
  });
}

export function deterministicReceiptEventKey(input: SourceRunReceiptInput, serializedPayload = JSON.stringify(input.payload)): string {
  const envelope = sourceRunExecutionEnvelopeSchema.parse(input.envelope);
  const material = [
    SOURCE_RUN_CONTRACT_VERSION,
    envelope.sourceRunAttemptId,
    envelope.executionUnitId,
    envelope.attemptFenceToken,
    input.stage,
    input.eventType,
    String(input.sequence),
    input.pageId ?? '',
    input.batchId ?? '',
    input.causationId ?? '',
    createHash('sha256').update(serializedPayload, 'utf8').digest('hex'),
  ].join('\n');
  return `receipt:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

export async function enqueueSourceRunReceipt(receipt: SourceRunReceipt): Promise<string> {
  const valid = sourceRunReceiptSchema.parse(receipt);
  const queue = getQueue(QUEUE_NAMES.LIFECYCLE_RECEIPTS);
  if (!queue) throw new Error('lifecycle receipt queue is unavailable');
  const job = await queue.add('source-run-receipt', { receipt: valid } satisfies LifecycleReceiptJob, {
    jobId: `receipt-${valid.producerEventKey.slice('receipt:'.length)}`,
    // A completed job means CMS acknowledged this exact immutable receipt.
    removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  });
  if (!job.id) throw new Error('lifecycle receipt queue did not return a durable job ID');
  return String(job.id);
}
