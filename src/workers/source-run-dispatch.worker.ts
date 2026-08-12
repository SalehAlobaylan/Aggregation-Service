/**
 * CMS source-run dispatcher.
 *
 * A tick contains no source, tenant, provider URL, or queue target. CMS alone
 * selects one eligible request and issues its fenced coordinator envelope.
 * The coordinator then admits exactly one initial fetch-page child. Provider
 * I/O happens only in that child worker after its own begin CAS.
 */
import { Job, Queue } from 'bullmq';
import { cmsClient } from '../cms/client.js';
import { type SourceRunDispatchClaim, type SourceRunExecutionEnvelope } from '../contracts/source-runs.js';
import { enqueueSourceRunReceipt, buildSourceRunReceipt } from '../services/lifecycle-receipts.js';
import { getQueue, QUEUE_NAMES, type FetchJob, type SourceRunDispatchJob, type SourceType } from '../queues/index.js';
import { createWorker } from './base-worker.js';
import { logger } from '../observability/logger.js';
import { isDependencyDeferral } from '../observability/job-projection.js';

const REPEATABLE_NAME = 'source-run-dispatch-repeatable';
const DISPATCH_INTERVAL_MS = 5_000;

interface ClaimedDispatchJob extends SourceRunDispatchJob {
  claim: SourceRunDispatchClaim;
}

function sourceRunSettings(sourceSettings: Record<string, unknown>, request: SourceRunDispatchClaim['request']): Record<string, unknown> {
  const settings = { ...sourceSettings };
	const metadata = request.metadata;
  // CMS request metadata is immutable evidence, but the dispatcher still
  // admits only the two bounded numeric intake limits. It never forwards an
  // arbitrary configuration object as a provider argument.
  for (const key of ['max_results', 'maxResults', 'initial_atomization_limit', 'initialAtomizationLimit']) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000) settings[key] = value;
  }
	settings.max_results = request.item_cap;
	settings.max_bytes = request.byte_cap;
	settings.max_provider_calls = request.provider_call_cap;
  const observationMap = metadata.deferred_observation_map;
  if (observationMap && typeof observationMap === 'object' && !Array.isArray(observationMap)) {
    const entries = Object.entries(observationMap).filter(([upstreamId, observationId]) =>
      upstreamId.length > 0 && upstreamId.length <= 255 && typeof observationId === 'string' && /^[0-9a-f-]{36}$/i.test(observationId),
    );
    if (entries.length > 0 && entries.length <= 20) settings.deferred_observation_map = Object.fromEntries(entries);
  }
  return settings;
}

function executionEnvelope(
  claim: SourceRunDispatchClaim,
  unit: { id: string; job_id: string; attempt_fence_token: string },
  lease: { execution_lease_token: string; execution_lease_expires_at: string },
): SourceRunExecutionEnvelope {
  return {
    contractVersion: 'source-run/v1',
    tenantId: claim.request.tenant_id,
    sourceRunRequestId: claim.request.id,
    sourceRunAttemptId: claim.attempt.id,
    executionUnitId: unit.id,
    contentSourceId: claim.request.source_id,
    attemptFenceToken: unit.attempt_fence_token,
    executionLeaseToken: lease.execution_lease_token,
    executionLeaseExpiresAt: lease.execution_lease_expires_at,
    unitJobId: unit.job_id,
  };
}

async function enqueueClaim(claim: SourceRunDispatchClaim): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.SOURCE_RUN_DISPATCH);
  if (!queue) throw new Error('source-run dispatch queue is unavailable');
  await queue.add('source-run-coordinator', { trigger: 'auto', claim } satisfies ClaimedDispatchJob, {
    // This is the only queue identity derived from a CMS-issued unit.
    jobId: claim.unit.job_id,
    priority: 1,
  });
}

// This is a separate, static recovery handshake. It has no queue name, unit,
// tenant, source, or provider input from a dashboard: CMS selects the one
// approved action and returns its fenced coordinator envelope. A queue add is
// only a handoff; CMS terminalizes the action later from its dispatch receipt.
async function processOneApprovedUnitAdoption(requestId?: string): Promise<boolean> {
  const action = await cmsClient.claimUnitAdoptionAction(requestId)
  if (!action) return false
  const claim = await cmsClient.prepareUnitAdoptionAction({ actionId: action.id, claimToken: action.claimToken }, requestId)
  await enqueueClaim(claim)
  await cmsClient.acknowledgeUnitAdoptionAction({ actionId: action.id, claimToken: action.claimToken }, requestId)
  return true
}

async function runClaimedCoordinator(claim: SourceRunDispatchClaim, requestId?: string): Promise<void> {
  // Reacquire if a queue delay outlived the initial dispatch lease. The CMS
  // endpoint will never reissue the attempt fence or accept a started effect.
  const rootLease = await cmsClient.acceptSourceRunUnit({
    tenantId: claim.request.tenant_id,
    requestId: claim.request.id,
    attemptId: claim.attempt.id,
    unitId: claim.unit.id,
    unitJobId: claim.unit.job_id,
    attemptFenceToken: claim.attempt.fence_token,
  }, requestId);
  const root = executionEnvelope(claim, { ...claim.unit, attempt_fence_token: claim.attempt.fence_token }, rootLease);

  const pageId = 'initial';
  const page = await cmsClient.authorizeSourceRunUnit({
    tenantId: claim.request.tenant_id,
    requestId: claim.request.id,
    attemptId: claim.attempt.id,
    parentUnitId: claim.unit.id,
    unitType: 'fetch_page',
    unitKey: `fetch:${pageId}`,
    pageId,
  }, requestId);
  const pageLease = await cmsClient.acceptSourceRunUnit({
    tenantId: claim.request.tenant_id,
    requestId: claim.request.id,
    attemptId: claim.attempt.id,
    unitId: page.id,
    unitJobId: page.job_id,
    attemptFenceToken: page.attempt_fence_token,
  }, requestId);
  const pageEnvelope = executionEnvelope(claim, page, pageLease);

  const fetchQueue = getQueue(QUEUE_NAMES.FETCH);
  if (!fetchQueue) throw new Error('fetch queue is unavailable for source-run page');
  const fetchJob: FetchJob = {
    sourceId: claim.source.id,
    sourceType: claim.source.type as SourceType,
    config: {
      name: claim.source.name,
      url: claim.source.url,
	  settings: sourceRunSettings(claim.source.settings, claim.request),
      pollIntervalMs: claim.source.fetch_interval_minutes * 60_000,
    },
    triggeredBy: 'schedule',
    triggeredAt: new Date().toISOString(),
    sourceRunRequestId: claim.request.id,
    tenantId: claim.request.tenant_id,
    sourceRun: pageEnvelope,
    sourceRunCoordinatorUnitId: claim.unit.id,
    sourceRunPageId: pageId,
  };
  await fetchQueue.add('source-run-fetch-page', fetchJob, { jobId: pageEnvelope.unitJobId, priority: 1 });

  // Retain the exact dispatch receipt after its child is durable. No browser
  // or queue acknowledgement is treated as provider completion.
  await enqueueSourceRunReceipt(buildSourceRunReceipt({
    envelope: root,
    stage: 'dispatch',
    eventType: 'accepted',
    outcome: 'no_change',
    sequence: 0,
    payload: { authorized_page_unit_id: page.id, page_id: pageId },
    pageId,
  }));
}

export const sourceRunDispatchWorker = createWorker({
  queueName: QUEUE_NAMES.SOURCE_RUN_DISPATCH,
  concurrency: 1,
  shouldDeadLetter: (job) => job.name !== REPEATABLE_NAME,
  shouldDeferFailure: (job, error) => job.name === REPEATABLE_NAME && isDependencyDeferral(error),
  processor: async (job: Job<SourceRunDispatchJob | ClaimedDispatchJob>, jobLogger): Promise<void> => {
    if ('claim' in job.data) {
      await runClaimedCoordinator(job.data.claim, job.id);
      return;
    }
		if (await processOneApprovedUnitAdoption(job.id)) {
			return;
		}
    const claim = await cmsClient.claimNextSourceRun(job.id);
    if (!claim) {
      jobLogger.debug('CMS source-run dispatcher found no eligible request');
      return;
    }
    await enqueueClaim(claim);
  },
});

export async function syncSourceRunDispatchSweeper(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.SOURCE_RUN_DISPATCH) as Queue | undefined;
  if (!queue) {
    logger.warn('source-run dispatcher: queue not initialized; skipping sync');
    return;
  }
  const repeatables = await queue.getRepeatableJobs().catch(() => []);
  await Promise.all(repeatables.filter((entry) => entry.name === REPEATABLE_NAME).map((entry) => queue.removeRepeatableByKey(entry.key).catch(() => undefined)));
  await queue.add(REPEATABLE_NAME, { trigger: 'auto' } satisfies SourceRunDispatchJob, {
    repeat: { every: DISPATCH_INTERVAL_MS },
    jobId: REPEATABLE_NAME,
    attempts: 1,
  });
  logger.info('source-run dispatcher: registered CMS admission tick', { intervalMs: DISPATCH_INTERVAL_MS });
}
