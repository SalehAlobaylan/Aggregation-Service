/**
 * CMS API Client with circuit breaker protection
 */
import { v4 as uuidv4 } from "uuid";
import { config } from "../config/index.js";
import { logger, createLogger } from "../observability/logger.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import type {
  CreateContentItemRequest,
  CreateContentItemResponse,
  UpdateContentItemRequest,
  UpdateStatusRequest,
  UpdateArtifactsRequest,
  CreateTranscriptRequest,
  CreateTranscriptResponse,
  RequestSttResponse,
  UpdateTranscriptionJobRequest,
  LinkTranscriptRequest,
  UpdateEmbeddingRequest,
  ApiResponse,
  ContentItem,
  InternalContentListResponse,
  ListStoragePoliciesResponse,
  ListStorageCandidatesResponse,
  ArchiveItemsRequest,
  ArchiveItemsResponse,
  CreateSweepRunRequest,
  MoveToColdRequest,
  MoveToColdResponse,
  StartStorageOperationSagaRequest,
  StorageOperationSaga,
  QualityProfile,
  ResolveProfileResponse,
  UpdateContentItemQualityRequest,
  UpdateContentItemQualityResponse,
  StorageArtifactEventRequest,
  InternalContentItem,
  WriteOpMetricsRequest,
  OpBudgetStatus,
  ListMissingEmbeddingResponse,
  NewsCirculationPolicy,
  ClaimCirculationSourcesResponse,
  ClaimMediaCirculationSourcesResponse,
  ReportSourceRunRequest,
  AtomizationInputResponse,
  AtomizationChapter,
  AtomizationRunReportRequest,
  AtomizationRunReportResponse,
  AtomizedChildResponse,
  ListAtomizationCandidatesResponse,
  AtomizationRepairResponse,
  ArtifactManifest,
  TranscriptionGeneration,
  TranscriptionSegmentUnit,
  AtomizationGeneration,
  AtomizationChapterUnit,
  MediaRenditionGeneration,
} from "./types.js";
import {
  sourceRunDispatchClaimSchema,
  sourceRunReceiptSchema,
  sourceRunAuthorizedUnitSchema,
  sourceRunVerificationClaimSchema,
  sourceRunVerificationObservationSchema,
  sourceRunUnitLeaseSchema,
  type SourceRunDispatchClaim,
  type SourceRunReceipt,
  type SourceRunAuthorizedUnit,
  type SourceRunUnitLease,
  type SourceRunVerificationClaim,
} from "../contracts/source-runs.js";
import { z } from "zod";
import type {
  ContentStageClaim,
  ContentStageCorrelation,
} from "../queues/schemas.js";

// Circuit breaker for CMS calls
const cmsCircuitBreaker = new CircuitBreaker({
  name: "cms",
  failureThreshold: 5,
  resetTimeout: 30000,
  halfOpenRequests: 3,
});

const CMS_REQUEST_TIMEOUT_MS = 10_000;
// Content ingest is a transactional CMS operation: it resolves durable source
// lineage and reconciles the content-stage manifest before replying. Against a
// remote PostgreSQL database that can legitimately take longer than the short
// control-plane deadline, especially while several normalize batches arrive in
// parallel. Keep the general deadline strict, but allow the idempotent ingest
// operation enough time to return its authoritative disposition.
const CMS_CONTENT_INGEST_TIMEOUT_MS = 60_000;
const CMS_CIRCULATION_CLAIM_TIMEOUT_MS = 60_000;
// A durable content-stage claim performs tenant fairness, dependency, fence,
// and fingerprint checks in one transaction. Remote PostgreSQL can exceed the
// generic control-plane deadline while a newly activated lane drains backlog.
const CMS_CONTENT_STAGE_CLAIM_TIMEOUT_MS = 60_000;
const CMS_MAX_SUCCESS_BODY_BYTES = 2 << 20;
const CMS_MAX_ERROR_BODY_BYTES = 16 << 10;

export class CMSRequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(`CMS request failed with status ${status}`);
    this.name = "CMSRequestError";
  }
}

export function isStaleContentStageDeliveryError(error: unknown): boolean {
  return error instanceof CMSRequestError && (error.status === 404 || error.status === 409);
}

async function readBoundedText(
  response: Response,
  limit: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("CMS response exceeded maximum body size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function countsAsCMSAvailabilityFailure(error: unknown): boolean {
  // Any completed HTTP response proves that CMS is reachable. Typed 4xx/5xx
  // operational refusals are handled by the calling job and must not open a
  // single global circuit that blocks unrelated claims, receipts and
  // verification. Only transport/deadline failures represent availability.
  if (error instanceof CMSRequestError) return false;
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

function sourceRunReceiptRequestBody(
  valid: SourceRunReceipt,
): Record<string, unknown> {
  return {
    tenant_id: valid.tenantId,
    producer_event_key: valid.producerEventKey,
    source_run_request_id: valid.sourceRunRequestId,
    source_run_attempt_id: valid.sourceRunAttemptId,
    execution_unit_id: valid.executionUnitId,
    content_source_id: valid.contentSourceId,
    unit_job_id: valid.unitJobId,
    attempt_fence_token: valid.attemptFenceToken,
    execution_lease_token: valid.executionLeaseToken,
    execution_lease_expires_at: valid.executionLeaseExpiresAt,
    schema_version: valid.schemaVersion,
    producer: valid.producer,
    stage: valid.stage,
    event_type: valid.eventType,
    outcome: valid.outcome,
    sequence: valid.sequence,
    page_id: valid.pageId,
    batch_id: valid.batchId,
    final_page: valid.finalPage,
    causation_id: valid.causationId,
    produced_at: valid.producedAt,
    payload: valid.payload,
    payload_digest: valid.payloadDigest,
  };
}

export function contentStageCorrelation(
  claim: ContentStageClaim,
  producerEventId = uuidv4(),
): ContentStageCorrelation {
  return {
    request_id: claim.request_id,
    attempt_id: claim.attempt_id,
    claim_token: claim.claim_token,
    fence_token: claim.fence_token,
    input_fingerprint: claim.input_fingerprint,
    producer_event_id: producerEventId,
  };
}

async function contentStageTransition<T = void>(
  claim: ContentStageClaim,
  action:
    | "begin"
    | "heartbeat"
    | "checkpoint"
    | "accepted"
    | "deferred"
    | "uncertain"
    | "failed"
    | "atomization-not-required",
  extra: Record<string, unknown>,
  requestId?: string,
): Promise<T> {
  return makeProtectedRequest<T>(
    "POST",
    `/content-stages/${encodeURIComponent(claim.request_id)}/${action}`,
    {
      ...contentStageCorrelation(claim, ""),
      ...extra,
    },
    requestId,
  );
}

/**
 * Build request headers with auth and tracing
 */
function buildHeaders(requestId?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.cmsServiceToken}`,
    "X-Service-Name": "aggregation-service",
    "X-Request-ID": requestId || uuidv4(),
  };
}

/**
 * Make an HTTP request to CMS API
 */
async function makeRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  requestId?: string,
  parentSignal?: AbortSignal,
  timeoutMs = CMS_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const url = `${config.cmsBaseUrl}${path}`;
  const reqId = requestId || uuidv4();
  const reqLogger = createLogger({ requestId: reqId });

  reqLogger.debug(`CMS API ${method} ${path}`);

  const response = await fetch(url, {
    method,
    headers: buildHeaders(reqId),
    body: body ? JSON.stringify(body) : undefined,
    signal: parentSignal
      ? AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    // Drain only a small bounded prefix so keep-alive resources are not
    // retained, but never return or log upstream-controlled error text.
    await readBoundedText(response, CMS_MAX_ERROR_BODY_BYTES).catch(() => "");
    reqLogger.error(`CMS API error: ${response.status}`, undefined, {
      status: response.status,
    });
    throw new CMSRequestError(
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }

  if (response.status === 204) {
    response.body?.cancel().catch(() => undefined);
    return undefined as T;
  }

  const raw = await readBoundedText(response, CMS_MAX_SUCCESS_BODY_BYTES);
  let data: T;
  try {
    data = JSON.parse(raw) as T;
  } catch {
    throw new Error("CMS returned invalid JSON");
  }
  reqLogger.debug(`CMS API response received`);
  return data;
}

/**
 * Make a request with circuit breaker protection
 */
async function makeProtectedRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  requestId?: string,
  parentSignal?: AbortSignal,
  timeoutMs = CMS_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return cmsCircuitBreaker.execute(
    () =>
      makeRequest<T>(method, path, body, requestId, parentSignal, timeoutMs),
    countsAsCMSAvailabilityFailure,
  );
}

/**
 * CMS API Client
 */
export const cmsClient = {
  async claimContentStage(
    lane: "news" | "pods",
    requestId?: string,
    stages?: string[],
  ): Promise<ContentStageClaim | null> {
    const query = stages?.length
      ? `?stages=${encodeURIComponent(stages.join(","))}`
      : "";
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      `/content-stages/${lane}/claim${query}`,
      {},
      requestId,
      undefined,
      CMS_CONTENT_STAGE_CLAIM_TIMEOUT_MS,
    );
    if (raw === undefined || raw === null) return null;
    return z
      .object({
        schema_version: z.literal("content-stage/v1"),
        request_id: z.string().uuid(),
        attempt_id: z.string().uuid(),
        tenant_id: z.string().min(1),
        content_item_id: z.string().uuid(),
        processing_generation: z.number().int().positive(),
        lane: z.enum(["news", "pods"]),
        stage: z.enum([
          "news_text_embedding",
          "news_story_classification",
          "news_asset",
          "news_llm_metadata",
          "pods_media_artifacts",
          "pods_text_embedding",
          "pods_transcript",
          "pods_atomization",
          "pods_caption_reembedding",
          "pods_image_embedding",
          "pods_llm_metadata",
        ]),
        input_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        claim_token: z.string().uuid(),
        fence_token: z.string().uuid(),
        lease_epoch: z.number().int().positive(),
        lease_expires_at: z.string().datetime({ offset: true }),
        deterministic_job_id: z.string().min(1),
        bounded_input: z
          .object({
            title: z.string().nullable().optional(),
            excerpt: z.string().nullable().optional(),
            body_text: z.string().nullable().optional(),
            content_language: z.string().nullable().optional(),
            content_type: z
              .enum(["NEWS", "ARTICLE", "VIDEO", "TWEET", "COMMENT", "PODCAST"])
              .optional(),
            original_url: z.string().url().nullable().optional(),
            source: z
              .enum([
                "RSS",
                "WEBSITE",
                "TELEGRAM",
                "YOUTUBE",
                "PODCAST",
                "PODCAST_DISCOVERY",
                "TWITTER",
                "REDDIT",
                "UPLOAD",
                "MANUAL",
              ])
              .optional(),
            source_name: z.string().nullable().optional(),
            playback_url: z.string().url().nullable().optional(),
            media_url: z.string().url().nullable().optional(),
            duration_sec: z.number().int().nullable().optional(),
            transcript_id: z.string().uuid().nullable().optional(),
            thumbnail_url: z.string().url().nullable().optional(),
            caption_text: z.string().max(12_000).optional(),
            caption_artifact: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      })
      .strict()
      .parse(raw) as ContentStageClaim;
  },
  async contentStageAccepted(
    claim: ContentStageClaim,
    requestId?: string,
  ): Promise<void> {
    await contentStageTransition(claim, "accepted", {}, requestId);
  },
  async beginContentStage(
    claim: ContentStageClaim,
    requestId?: string,
  ): Promise<void> {
    await contentStageTransition(claim, "begin", {}, requestId);
  },
  async heartbeatContentStage(
    claim: ContentStageClaim,
    requestId?: string,
  ): Promise<{ lease_expires_at: string }> {
    return contentStageTransition<{ lease_expires_at: string }>(claim, "heartbeat", {}, requestId);
  },
  async checkpointContentStage(
    claim: ContentStageClaim,
    phase: string,
    proof: Record<string, unknown> = {},
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    await makeProtectedRequest<void>(
      "POST",
      `/content-stages/${encodeURIComponent(claim.request_id)}/checkpoint`,
      {
        ...contentStageCorrelation(claim, ""),
        phase,
        proof,
      },
      requestId,
      parentSignal,
    );
  },
  async deferContentStage(
    claim: ContentStageClaim,
    retryAfterSec: number,
    summary: string,
    requestId?: string,
  ): Promise<void> {
    await contentStageTransition(
      claim,
      "deferred",
      { retry_after_sec: retryAfterSec, summary },
      requestId,
    );
  },
  async uncertainContentStage(
    claim: ContentStageClaim,
    summary: string,
    requestId?: string,
  ): Promise<void> {
    await contentStageTransition(claim, "uncertain", { summary }, requestId);
  },
  async failContentStage(
    claim: ContentStageClaim,
    failureClass: string,
    summary: string,
    requestId?: string,
  ): Promise<void> {
    await contentStageTransition(
      claim,
      "failed",
      { failure_class: failureClass, summary },
      requestId,
    );
  },
  async settleAtomizationNotRequired(
    claim: ContentStageClaim,
    summary: string,
    requestId?: string,
  ): Promise<void> {
    await contentStageTransition(
      claim,
      "atomization-not-required",
      { summary },
      requestId,
    );
  },
  async claimAtomizationWork(requestId?: string): Promise<{
    id: string;
    attemptId: string;
    claimToken: string;
    fenceToken: string;
    deterministicJobId: string;
    inputFingerprint: string;
    parentContentItemId: string;
  } | null> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      "/atomization-work/claim",
      {},
      requestId,
    );
    if (raw === undefined || raw === null) return null;
    const parsed = z
      .object({
        id: z.string().uuid(),
        attempt_id: z.string().uuid(),
        claim_token: z.string().uuid(),
        fence_token: z.string().uuid(),
        deterministic_job_id: z.string().min(1),
        input_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        parent_content_item_id: z.string().uuid(),
      })
      .strict()
      .parse(raw);
    return {
      id: parsed.id,
      attemptId: parsed.attempt_id,
      claimToken: parsed.claim_token,
      fenceToken: parsed.fence_token,
      deterministicJobId: parsed.deterministic_job_id,
      inputFingerprint: parsed.input_fingerprint,
      parentContentItemId: parsed.parent_content_item_id,
    };
  },
  async beginAtomizationWork(
    input: { id: string; claimToken: string },
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/atomization-work/${encodeURIComponent(input.id)}/begin`,
      { claim_token: input.claimToken },
      requestId,
    );
  },
  async heartbeatAtomizationWork(
    input: { id: string; claimToken: string },
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/atomization-work/${encodeURIComponent(input.id)}/heartbeat`,
      { claim_token: input.claimToken },
      requestId,
    );
  },
  async deferAtomizationWork(
    input: {
      id: string;
      claimToken: string;
      retryAfterSec: number;
      summary: string;
    },
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/atomization-work/${encodeURIComponent(input.id)}/defer`,
      {
        claim_token: input.claimToken,
        retry_after_sec: input.retryAfterSec,
        summary: input.summary,
      },
      requestId,
    );
  },
  async checkpointAtomizationWork(
    input: {
      id: string;
      claimToken: string;
      phase:
        | "plan_persisted"
        | "first_cut"
        | "uploads_complete"
        | "children_persisted"
        | "embedding_handoff"
        | "owner_complete";
      proof: Record<string, unknown>;
    },
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/atomization-work/${encodeURIComponent(input.id)}/checkpoint`,
      { claim_token: input.claimToken, phase: input.phase, proof: input.proof },
      requestId,
    );
  },
  async claimPipelineRepair(requestId?: string): Promise<{
    id: string;
    attemptId: string;
    tenantId: string;
    claimToken: string;
    deterministicJobId: string;
    stage:
      | "media_download"
      | "media_transcode"
      | "media_thumbnail"
      | "media_delivery_generation"
      | "text_embedding";
    contentItemId: string;
    itemVersion: string;
    sourceRunRequestId?: number;
    fenceToken: string;
    leaseExpiresAt: string;
    leaseEpoch: number;
    effectInputDigest: string;
    content: {
      type: "NEWS" | "ARTICLE" | "VIDEO" | "TWEET" | "COMMENT" | "PODCAST";
      source: string;
      original_url?: string | null;
      media_url?: string | null;
      title?: string | null;
      excerpt?: string | null;
      body_text?: string | null;
      metadata?: Record<string, unknown>;
    };
  } | null> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      "/pipeline-repairs/claim",
      {},
      requestId,
    );
    if (raw === undefined || raw === null) return null;
    const parsed = z
      .object({
        id: z.string().uuid(),
        attempt_id: z.string().uuid(),
        tenant_id: z.string().min(1),
        claim_token: z.string().uuid(),
        deterministic_job_id: z.string().min(1),
        stage: z.enum([
          "media_download",
          "media_transcode",
          "media_thumbnail",
          "media_delivery_generation",
          "text_embedding",
        ]),
        content_item_id: z.string().uuid(),
        item_version: z.string().datetime({ offset: true }),
        source_run_request_id: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional(),
        fence_token: z.string().uuid(),
        lease_expires_at: z.string().datetime({ offset: true }),
        lease_epoch: z.number().int().positive(),
        effect_input_digest: z.string().regex(/^[a-f0-9]{64}$/),
        content: z
          .object({
            type: z.enum([
              "NEWS",
              "ARTICLE",
              "VIDEO",
              "TWEET",
              "COMMENT",
              "PODCAST",
            ]),
            source: z.string().min(1),
            original_url: z.string().url().nullable().optional(),
            media_url: z.string().url().nullable().optional(),
            title: z.string().nullable().optional(),
            excerpt: z.string().nullable().optional(),
            body_text: z.string().nullable().optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      })
      .strict()
      .parse(raw);
    return {
      id: parsed.id,
      attemptId: parsed.attempt_id,
      tenantId: parsed.tenant_id,
      claimToken: parsed.claim_token,
      deterministicJobId: parsed.deterministic_job_id,
      stage: parsed.stage,
      contentItemId: parsed.content_item_id,
      itemVersion: parsed.item_version,
      sourceRunRequestId: parsed.source_run_request_id ?? undefined,
      fenceToken: parsed.fence_token,
      leaseExpiresAt: parsed.lease_expires_at,
      leaseEpoch: parsed.lease_epoch,
      effectInputDigest: parsed.effect_input_digest,
      content: parsed.content,
    };
  },
  async beginPipelineRepair(
    input: { repairId: string; claimToken: string },
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/pipeline-repairs/${encodeURIComponent(input.repairId)}/begin`,
      { claim_token: input.claimToken },
      requestId,
    );
  },
  async heartbeatPipelineRepair(
    input: { repairId: string; claimToken: string },
    requestId?: string,
  ): Promise<{ lease_expires_at: string }> {
    return makeProtectedRequest<{ lease_expires_at: string }>(
      "POST",
      `/pipeline-repairs/${encodeURIComponent(input.repairId)}/heartbeat`,
      { claim_token: input.claimToken },
      requestId,
    );
  },
  async completePipelineRepair(
    input: {
      repairId: string;
      claimToken: string;
      producerEventId: string;
      outputDigest: string;
      output: Record<string, unknown>;
    },
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/pipeline-repairs/${encodeURIComponent(input.repairId)}/terminal`,
      {
        claim_token: input.claimToken,
        producer_event_id: input.producerEventId,
        output_digest: input.outputDigest,
        output: input.output,
      },
      requestId,
    );
  },
  async claimUnitAdoptionAction(
    requestId?: string,
  ): Promise<{ id: string; claimToken: string } | null> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      "/media-supply-actions/unit-adoptions/claim",
      {},
      requestId,
    );
    if (raw === undefined || raw === null) return null;
    return z
      .object({ id: z.string().uuid(), claim_token: z.string().uuid() })
      .strict()
      .transform((value) => ({ id: value.id, claimToken: value.claim_token }))
      .parse(raw);
  },

  async prepareUnitAdoptionAction(
    input: { actionId: string; claimToken: string },
    requestId?: string,
  ): Promise<SourceRunDispatchClaim> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      `/media-supply-actions/unit-adoptions/${encodeURIComponent(input.actionId)}/prepare`,
      { claim_token: input.claimToken },
      requestId,
    );
    return sourceRunDispatchClaimSchema.parse(raw);
  },

  async acknowledgeUnitAdoptionAction(
    input: { actionId: string; claimToken: string },
    requestId?: string,
  ): Promise<void> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      `/media-supply-actions/unit-adoptions/${encodeURIComponent(input.actionId)}/acknowledge`,
      { claim_token: input.claimToken },
      requestId,
    );
    z.object({ ok: z.literal(true), state: z.literal("verifying") })
      .strict()
      .parse(raw);
  },
  async claimReceiptRedeliveryAction(
    requestId?: string,
  ): Promise<{ id: string; claimToken: string } | null> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      "/media-supply-actions/receipt-redeliveries/claim",
      {},
      requestId,
    );
    if (raw === undefined || raw === null) return null;
    return z
      .object({ id: z.string().uuid(), claim_token: z.string().uuid() })
      .strict()
      .transform((value) => ({ id: value.id, claimToken: value.claim_token }))
      .parse(raw);
  },
  async prepareReceiptRedeliveryAction(
    input: { actionId: string; claimToken: string },
    requestId?: string,
  ): Promise<SourceRunReceipt> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      `/media-supply-actions/receipt-redeliveries/${encodeURIComponent(input.actionId)}/prepare`,
      { claim_token: input.claimToken },
      requestId,
    );
    return sourceRunReceiptSchema.parse(raw);
  },
  async completeReceiptRedeliveryAction(
    input: { actionId: string; claimToken: string },
    requestId?: string,
  ): Promise<void> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      `/media-supply-actions/receipt-redeliveries/${encodeURIComponent(input.actionId)}/complete`,
      { claim_token: input.claimToken },
      requestId,
    );
    z.object({ ok: z.literal(true), state: z.literal("succeeded") })
      .strict()
      .parse(raw);
  },

  async claimNextSourceRun(
    requestId?: string,
  ): Promise<SourceRunDispatchClaim | null> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      "/source-runs/claim",
      {},
      requestId,
    );
    if (raw === undefined || raw === null) return null;
    return sourceRunDispatchClaimSchema.parse(raw);
  },

  async authorizeSourceRunUnit(
    input: {
      tenantId: string;
      requestId: string;
      attemptId: string;
      parentUnitId: string;
      unitType: "fetch_page" | "normalize_batch";
      unitKey: string;
      pageId: string;
      batchId?: string;
    },
    requestId?: string,
  ): Promise<SourceRunAuthorizedUnit> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      `/source-runs/${encodeURIComponent(input.requestId)}/attempts/${encodeURIComponent(input.attemptId)}/units`,
      {
        tenant_id: input.tenantId,
        parent_unit_id: input.parentUnitId,
        unit_type: input.unitType,
        unit_key: input.unitKey,
        page_id: input.pageId,
        batch_id: input.batchId ?? "",
      },
      requestId,
    );
    return sourceRunAuthorizedUnitSchema.parse(raw);
  },

  async acceptSourceRunUnit(
    input: {
      tenantId: string;
      requestId: string;
      attemptId: string;
      unitId: string;
      unitJobId: string;
      attemptFenceToken: string;
    },
    requestId?: string,
  ): Promise<SourceRunUnitLease> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      `/source-runs/${encodeURIComponent(input.requestId)}/attempts/${encodeURIComponent(input.attemptId)}/units/${encodeURIComponent(input.unitId)}/accepted`,
      {
        tenant_id: input.tenantId,
        unit_job_id: input.unitJobId,
        attempt_fence_token: input.attemptFenceToken,
      },
      requestId,
    );
    return sourceRunUnitLeaseSchema.parse(raw);
  },

  async beginSourceRunUnit(
    input: {
      tenantId: string;
      requestId: string;
      attemptId: string;
      unitId: string;
      unitJobId: string;
      attemptFenceToken: string;
      executionLeaseToken: string;
    },
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/source-runs/${encodeURIComponent(input.requestId)}/attempts/${encodeURIComponent(input.attemptId)}/units/${encodeURIComponent(input.unitId)}/begin`,
      {
        tenant_id: input.tenantId,
        unit_job_id: input.unitJobId,
        attempt_fence_token: input.attemptFenceToken,
        execution_lease_token: input.executionLeaseToken,
      },
      requestId,
    );
  },

  async heartbeatSourceRunUnit(
    input: {
      tenantId: string;
      requestId: string;
      attemptId: string;
      unitId: string;
      unitJobId: string;
      attemptFenceToken: string;
      executionLeaseToken: string;
    },
    requestId?: string,
  ): Promise<{ executionLeaseExpiresAt: string }> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      `/source-runs/${encodeURIComponent(input.requestId)}/attempts/${encodeURIComponent(input.attemptId)}/units/${encodeURIComponent(input.unitId)}/heartbeat`,
      {
        tenant_id: input.tenantId,
        unit_job_id: input.unitJobId,
        attempt_fence_token: input.attemptFenceToken,
        execution_lease_token: input.executionLeaseToken,
      },
      requestId,
    );
    const parsed = z
      .object({
        ok: z.literal(true),
        execution_lease_expires_at: z.string().datetime({ offset: true }),
      })
      .strict()
      .parse(raw);
    return { executionLeaseExpiresAt: parsed.execution_lease_expires_at };
  },

  async freezeSourceRunPage(
    input: {
      tenantId: string;
      requestId: string;
      attemptId: string;
      unitId: string;
      declaredChildCount: number;
      declaredChildDigest: string;
    },
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/source-runs/${encodeURIComponent(input.requestId)}/attempts/${encodeURIComponent(input.attemptId)}/units/${encodeURIComponent(input.unitId)}/freeze`,
      {
        tenant_id: input.tenantId,
        declared_child_count: input.declaredChildCount,
        declared_child_digest: input.declaredChildDigest,
      },
      requestId,
    );
  },

  async recordSourceRunUpstreamObservations(
    input: {
      tenantId: string;
      requestId: string;
      attemptId: string;
      unitId: string;
      unitJobId: string;
      attemptFenceToken: string;
      executionLeaseToken: string;
      providerCapability: "replayable_listing" | "peek";
      providerVersion: string;
      providerPageId: string;
      providerCursor?: string;
      items: Array<{ upstreamItemId: string; upstreamFingerprint: string }>;
    },
    requestId?: string,
  ): Promise<{ created: number }> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      `/source-runs/${encodeURIComponent(input.requestId)}/attempts/${encodeURIComponent(input.attemptId)}/units/${encodeURIComponent(input.unitId)}/upstream-observations`,
      {
        tenant_id: input.tenantId,
        unit_job_id: input.unitJobId,
        attempt_fence_token: input.attemptFenceToken,
        execution_lease_token: input.executionLeaseToken,
        provider_capability: input.providerCapability,
        provider_version: input.providerVersion,
        provider_page_id: input.providerPageId,
        provider_cursor: input.providerCursor ?? "",
        items: input.items.map((item) => ({
          upstream_item_id: item.upstreamItemId,
          upstream_fingerprint: item.upstreamFingerprint,
        })),
      },
      requestId,
    );
    return z
      .object({ ok: z.literal(true), created: z.number().int().nonnegative() })
      .strict()
      .parse(raw);
  },

  async recordSourceRunUpstreamObservationDisposition(
    input: {
      tenantId: string;
      requestId: string;
      attemptId: string;
      unitId: string;
      unitJobId: string;
      attemptFenceToken: string;
      executionLeaseToken: string;
      observationId: string;
      disposition: "materialized" | "filtered";
      contentItemId?: string;
      filterClass?:
        | "include_keywords"
        | "exclude_keywords"
        | "min_engagement"
        | "moderation_rejected"
        | "normalization_unsupported"
        | "exact_duplicate"
        | "duration_below_minimum";
    },
    requestId?: string,
  ): Promise<{ created: boolean }> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      `/source-runs/${encodeURIComponent(input.requestId)}/attempts/${encodeURIComponent(input.attemptId)}/units/${encodeURIComponent(input.unitId)}/upstream-observations/${encodeURIComponent(input.observationId)}/disposition`,
      {
        tenant_id: input.tenantId,
        unit_job_id: input.unitJobId,
        attempt_fence_token: input.attemptFenceToken,
        execution_lease_token: input.executionLeaseToken,
        disposition: input.disposition,
        content_item_id: input.contentItemId ?? "",
        filter_class: input.filterClass ?? "",
      },
      requestId,
    );
    return z
      .object({ ok: z.literal(true), created: z.boolean() })
      .strict()
      .parse(raw);
  },

  async sealSourceRunManifest(
    input: { tenantId: string; requestId: string },
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/source-runs/${encodeURIComponent(input.requestId)}/seal`,
      { tenant_id: input.tenantId },
      requestId,
    );
  },

  async claimNextSourceRunVerification(
    requestId?: string,
  ): Promise<SourceRunVerificationClaim | null> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      "/source-run-verification-tasks/claim-next",
      {},
      requestId,
    );
    if (raw === undefined || raw === null) return null;
    return sourceRunVerificationClaimSchema.parse(raw);
  },

  async observeSourceRunVerification(
    input: { tenantId: string; taskId: string; claimToken: string },
    requestId?: string,
  ): Promise<{
    verdict: "present" | "absent" | "unknown";
    evidenceSnapshot: string;
  }> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      `/source-run-verification-tasks/${encodeURIComponent(input.taskId)}/observe`,
      { tenant_id: input.tenantId, claim_token: input.claimToken },
      requestId,
    );
    const parsed = sourceRunVerificationObservationSchema.parse(raw);
    return {
      verdict: parsed.verdict,
      evidenceSnapshot: parsed.evidence_snapshot,
    };
  },

  async deliverSourceRunReceipt(
    receipt: SourceRunReceipt,
    requestId?: string,
  ): Promise<void> {
    const valid = sourceRunReceiptSchema.parse(receipt);
    await makeProtectedRequest(
      "POST",
      "/source-run-receipts",
      sourceRunReceiptRequestBody(valid),
      requestId,
    );
  },
  async retainSourceRunReceipt(
    receipt: SourceRunReceipt,
    requestId?: string,
  ): Promise<void> {
    const valid = sourceRunReceiptSchema.parse(receipt);
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      "/source-run-receipts/retain",
      sourceRunReceiptRequestBody(valid),
      requestId,
    );
    z.object({
      id: z.string().uuid(),
      duplicate: z.boolean(),
      state: z.literal("retained"),
    })
      .strict()
      .parse(raw);
  },
  async markSourceRunReceiptDelivered(
    receipt: SourceRunReceipt,
    requestId?: string,
  ): Promise<void> {
    const valid = sourceRunReceiptSchema.parse(receipt);
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      "/source-run-receipts/delivered",
      { tenant_id: valid.tenantId, producer_event_key: valid.producerEventKey },
      requestId,
    );
    z.object({ id: z.string().uuid(), state: z.literal("delivered") })
      .strict()
      .parse(raw);
  },
  async redundancyPrecheck(
    candidates: Array<{
      title: string;
      duration_sec?: number;
      source_url?: string;
    }>,
    requestId?: string,
  ): Promise<{
    candidates: Array<{
      verdict: "clear" | "exact_identity" | "likely_duplicate";
      existing_item_id?: string;
      confidence: number;
      reasons: string[];
    }>;
  }> {
    return makeProtectedRequest(
      "POST",
      "/redundancy/precheck",
      { candidates },
      requestId,
    );
  },
  /**
   * Ping CMS for dependency liveness. This deliberately bypasses the
   * operational request circuit: /ready must be able to distinguish a live
   * CMS from a circuit opened by a typed operational refusal. Feeding the
   * shared circuit back into owner readiness creates a CMS <-> Aggregation
   * readiness deadlock.
   */
  async ping(requestId?: string): Promise<boolean> {
    try {
      const pingPath = process.env["CMS_PING_PATH"] || "/live";
      const url = `${config.cmsBaseUrl.replace(/\/internal\/?$/, "")}${pingPath}`;
      const response = await fetch(url, {
        method: "GET",
        headers: buildHeaders(requestId),
        signal: AbortSignal.timeout(CMS_REQUEST_TIMEOUT_MS),
      });
      try {
        if (!response.ok) {
          return false;
        }
        await readBoundedText(response, CMS_MAX_ERROR_BODY_BYTES);
        return true;
      } finally {
        response.body?.cancel().catch(() => undefined);
      }
    } catch (error) {
      logger.warn("CMS ping failed", { error });
      return false;
    }
  },

  /**
   * Check if circuit breaker is allowing requests
   */
  isAvailable(): boolean {
    return cmsCircuitBreaker.isAllowingRequests();
  },

  /**
   * Create a new content item
   * POST /internal/content-items
   */
  async createContentItem(
    data: CreateContentItemRequest,
    requestId?: string,
  ): Promise<CreateContentItemResponse> {
    return makeProtectedRequest<CreateContentItemResponse>(
      "POST",
      "/content-items",
      data,
      requestId,
      undefined,
      CMS_CONTENT_INGEST_TIMEOUT_MS,
    );
  },

  /**
   * Post discovered source candidates to CMS for admin review.
   * POST /internal/source-suggestions
   */
  async postSourceSuggestions(
    data: { tenantId?: string; profileId?: string; candidates: unknown[] },
    requestId?: string,
  ): Promise<{ upserted: number; skipped: number }> {
    return makeProtectedRequest<{ upserted: number; skipped: number }>(
      "POST",
      "/source-suggestions",
      {
        tenant_id: data.tenantId,
        profile_id: data.profileId,
        candidates: data.candidates,
      },
      requestId,
    );
  },

  /**
   * Read the tenant's discovery config (sweep interval, automation, knobs).
   * GET /internal/discovery/config
   */
  async getDiscoveryConfig(requestId?: string): Promise<{
    automation_enabled: boolean;
    sweep_interval_hours: number;
    recency_window_days: number;
    max_candidates_per_profile: number;
    search_provider: string;
    intelligence_enabled: boolean;
    telegram_discovery_enabled: boolean;
    twitter_discovery_enabled: boolean;
    twitter_recommend_enabled: boolean;
    youtube_discovery_enabled: boolean;
    podcast_discovery_enabled: boolean;
    youtube_related_enabled: boolean;
    apple_related_enabled: boolean;
    graph_build_interval_hours: number;
  }> {
    return makeRequest("GET", "/discovery/config", undefined, requestId);
  },

  /**
   * Source-graph signals + ledger write-back (Slice 4).
   */
  async getCorpusCitations(requestId?: string): Promise<{
    data: { domain: string; count: number; recent_count: number }[];
  }> {
    return makeRequest("GET", "/intel/corpus-citations", undefined, requestId);
  },
  async getApprovedSourcePages(
    requestId?: string,
  ): Promise<{ data: { host: string; site_url: string; feed_url: string }[] }> {
    return makeRequest(
      "GET",
      "/intel/approved-source-pages",
      undefined,
      requestId,
    );
  },
  async getApprovedTelegramChannels(
    requestId?: string,
  ): Promise<{ data: { username: string }[] }> {
    return makeRequest(
      "GET",
      "/intel/approved-telegram-channels",
      undefined,
      requestId,
    );
  },
  async getApprovedTwitterHandles(
    requestId?: string,
  ): Promise<{ data: { username: string }[] }> {
    return makeRequest(
      "GET",
      "/intel/approved-twitter-handles",
      undefined,
      requestId,
    );
  },
  async getApprovedYouTubeChannels(
    requestId?: string,
  ): Promise<{ data: { channel: string }[] }> {
    return makeRequest(
      "GET",
      "/intel/approved-youtube-channels",
      undefined,
      requestId,
    );
  },
  async getApprovedPodcastFeeds(
    requestId?: string,
  ): Promise<{ data: { feed_url: string }[] }> {
    return makeRequest(
      "GET",
      "/intel/approved-podcast-feeds",
      undefined,
      requestId,
    );
  },
  async postCandidates(
    data: {
      candidates: unknown[];
      edges: { from_host: string; to_host: string; weight: number }[];
    },
    requestId?: string,
  ): Promise<{ candidates: number; edges: number; promoted: number }> {
    return makeProtectedRequest("POST", "/intel/candidates", data, requestId);
  },

  /**
   * List enabled discovery profiles for the scheduled sweep fan-out.
   * GET /internal/discovery/profiles?enabled=true
   */
  async listEnabledDiscoveryProfiles(requestId?: string): Promise<{
    data: Array<{
      id: string;
      name: string;
      description?: string;
      keywords?: string[];
      languages?: string[];
      category?: string;
      max_suggestions_per_run?: number;
    }>;
  }> {
    return makeRequest(
      "GET",
      "/discovery/profiles?enabled=true",
      undefined,
      requestId,
    );
  },

  async getCirculationPolicy(
    tenantId = "default",
    requestId?: string,
    parentSignal?: AbortSignal,
    lane: "news" | "media" = "news",
  ): Promise<NewsCirculationPolicy> {
    return makeRequest(
      "GET",
      `/circulation/policy?tenant_id=${encodeURIComponent(tenantId)}&lane=${lane}`,
      undefined,
      requestId,
      parentSignal,
    );
  },

  async claimCirculationSources(
    tenantId = "default",
    limit = 20,
    force = false,
    requestId?: string,
    recovery?: {
      runId: string;
      manifestHash: string;
      lane: "news" | "media";
      sourceIds: string[];
      lookbackHours: number;
      maxItems: number;
      preserveCheckpoints: true;
    },
    parentSignal?: AbortSignal,
  ): Promise<ClaimCirculationSourcesResponse> {
    const recoveryQuery = recovery
      ? `&recovery_lane=${recovery.lane}&recovery_run_id=${encodeURIComponent(recovery.runId)}&recovery_manifest_hash=${encodeURIComponent(recovery.manifestHash)}&recovery_source_ids=${encodeURIComponent(recovery.sourceIds.join(","))}&recovery_lookback_hours=${recovery.lookbackHours}&recovery_max_items=${recovery.maxItems}&preserve_checkpoints=true`
      : "";
    return makeProtectedRequest(
      "POST",
      `/circulation/claim-sources?tenant_id=${encodeURIComponent(tenantId)}&limit=${limit}&force=${force ? "true" : "false"}${recoveryQuery}`,
      {},
      requestId,
      parentSignal,
      CMS_CIRCULATION_CLAIM_TIMEOUT_MS,
    );
  },

  async claimMediaCirculationSources(
    tenantId = "default",
    limit = 0,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<ClaimMediaCirculationSourcesResponse> {
    return makeProtectedRequest(
      "POST",
      `/circulation/claim-sources?lane=media&tenant_id=${encodeURIComponent(tenantId)}&limit=${limit}`,
      {},
      requestId,
      parentSignal,
      CMS_CIRCULATION_CLAIM_TIMEOUT_MS,
    );
  },

  async reportSourceRun(
    data: ReportSourceRunRequest,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      "/circulation/source-runs",
      data,
      requestId,
      parentSignal,
    );
  },

  async acceptSourceRunRequest(
    sourceRunRequestId: string,
    jobId: string,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/source-run-requests/${encodeURIComponent(sourceRunRequestId)}/accepted`,
      { job_id: jobId },
      requestId,
      parentSignal,
    );
  },

  /**
   * Update an existing content item
   * PUT /internal/content-items/:id
   */
  async updateContentItem(
    id: string,
    data: UpdateContentItemRequest,
    requestId?: string,
  ): Promise<ContentItem> {
    return makeProtectedRequest<ContentItem>(
      "PUT",
      `/content-items/${id}`,
      data,
      requestId,
    );
  },

  /**
   * Update content item status
   * PATCH /internal/content-items/:id/status
   */
  async updateStatus(
    id: string,
    data: UpdateStatusRequest,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    await makeProtectedRequest<void>(
      "PATCH",
      `/content-items/${id}/status`,
      data,
      requestId,
      parentSignal,
    );
  },

  /**
   * Update content item artifacts (media_url, thumbnail_url, duration_sec)
   * PATCH /internal/content-items/:id/artifacts
   */
  async updateArtifacts(
    id: string,
    data: UpdateArtifactsRequest,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    await makeProtectedRequest<void>(
      "PATCH",
      `/content-items/${id}/artifacts`,
      data,
      requestId,
      parentSignal,
    );
  },

  /**
   * Create a transcript
   * POST /internal/transcripts
   */
  async createTranscript(
    data: CreateTranscriptRequest,
    requestId?: string,
  ): Promise<CreateTranscriptResponse> {
    return makeProtectedRequest<CreateTranscriptResponse>(
      "POST",
      "/transcripts",
      data,
      requestId,
    );
  },

  /**
   * Request STT for a content item (auto/manual upgrade path).
   * POST /internal/content-items/:id/request-stt
   *
   * The guard (auto-STT toggle + caption-state machine + budget cap) lives in
   * CMS, so Aggregation just asks and CMS decides whether to invoke Media.
   * `force=true` is the manual upgrade (budget cap still applies).
   */
  async requestStt(
    contentItemId: string,
    force = false,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<RequestSttResponse> {
    return makeProtectedRequest<RequestSttResponse>(
      "POST",
      `/content-items/${contentItemId}/request-stt`,
      { force },
      requestId,
      parentSignal,
    );
  },

  async updateTranscriptionJob(
    transcriptionJobId: string,
    data: UpdateTranscriptionJobRequest,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    await makeProtectedRequest(
      "PATCH",
      `/transcription-jobs/${transcriptionJobId}`,
      data,
      requestId,
      parentSignal,
    );
  },

  /**
   * Link transcript to content item
   * PATCH /internal/content-items/:id/transcript
   */
  async linkTranscript(
    contentItemId: string,
    data: LinkTranscriptRequest,
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest<void>(
      "PATCH",
      `/content-items/${contentItemId}/transcript`,
      data,
      requestId,
    );
  },

  /**
   * Update content item embedding
   * PATCH /internal/content-items/:id/embedding
   */
  async updateEmbedding(
    id: string,
    data: UpdateEmbeddingRequest,
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest<void>(
      "PATCH",
      `/content-items/${id}/embedding`,
      data,
      requestId,
    );
  },

  /**
   * List content items with optional filters
   * GET /internal/content-items?status=FAILED&source=TELEGRAM&ids=a,b&limit=100&page=1
   */
  async listContentItems(
    params: {
      status?: string;
      source?: string;
      ids?: string[];
      limit?: number;
      page?: number;
    },
    requestId?: string,
  ): Promise<InternalContentListResponse> {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.source) qs.set("source", params.source);
    if (params.ids?.length) qs.set("ids", params.ids.join(","));
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.page) qs.set("page", String(params.page));
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return makeRequest<InternalContentListResponse>(
      "GET",
      `/content-items${query}`,
      undefined,
      requestId,
    );
  },

  /**
   * GET /internal/content-items/missing-embedding?limit=N
   * READY items still lacking a dense embedding — drives the reconciliation
   * sweep (H2 backstop).
   */
  async listMissingEmbedding(
    limit: number,
    requestId?: string,
  ): Promise<ListMissingEmbeddingResponse> {
    return makeRequest<ListMissingEmbeddingResponse>(
      "GET",
      `/content-items/missing-embedding?limit=${limit}`,
      undefined,
      requestId,
    );
  },

  /**
   * Reconcile FAILED rows whose required artifact is already present. This is
   * a CMS-local repair and deliberately does not enqueue another embedding.
   */
  async reconcileArtifactCompleteStatuses(
    limit = 50,
    requestId?: string,
  ): Promise<{ reconciled: number; scanned: number }> {
    return makeProtectedRequest<{ reconciled: number; scanned: number }>(
      "POST",
      `/content-items/reconcile-artifact-complete?limit=${Math.max(1, Math.min(200, Math.floor(limit)))}`,
      {},
      requestId,
    );
  },

  // ---------------------------------------------------------------
  // Storage management
  // ---------------------------------------------------------------

  /**
   * GET /internal/storage/policies
   */
  async listStoragePolicies(
    requestId?: string,
  ): Promise<ListStoragePoliciesResponse> {
    return makeRequest<ListStoragePoliciesResponse>(
      "GET",
      "/storage/policies",
      undefined,
      requestId,
    );
  },

  /**
   * GET /internal/storage/candidates
   */
  async listStorageCandidates(
    params: {
      tenant_id: string;
      min_age_days?: number;
      max_view_count?: number;
      limit?: number;
      delete_failed_immediately?: boolean;
      max_bytes?: number;
      ids?: string[];
      include_atomized_parents?: boolean;
      archive_action?: "delete" | "move_to_cold" | "re_encode" | string;
    },
    requestId?: string,
  ): Promise<ListStorageCandidatesResponse> {
    const qs = new URLSearchParams();
    qs.set("tenant_id", params.tenant_id);
    if (params.min_age_days !== undefined)
      qs.set("min_age_days", String(params.min_age_days));
    if (params.max_view_count !== undefined)
      qs.set("max_view_count", String(params.max_view_count));
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.delete_failed_immediately !== undefined)
      qs.set(
        "delete_failed_immediately",
        String(params.delete_failed_immediately),
      );
    if (params.max_bytes !== undefined)
      qs.set("max_bytes", String(params.max_bytes));
    if (params.ids?.length) qs.set("ids", params.ids.join(","));
    if (params.include_atomized_parents !== undefined)
      qs.set(
        "include_atomized_parents",
        String(params.include_atomized_parents),
      );
    if (params.archive_action !== undefined)
      qs.set("archive_action", String(params.archive_action));
    return makeRequest<ListStorageCandidatesResponse>(
      "GET",
      `/storage/candidates?${qs.toString()}`,
      undefined,
      requestId,
    );
  },

  /**
   * POST /internal/storage/archive
   */
  async archiveItems(
    data: ArchiveItemsRequest,
    requestId?: string,
  ): Promise<ArchiveItemsResponse> {
    return makeProtectedRequest<ArchiveItemsResponse>(
      "POST",
      "/storage/archive",
      data,
      requestId,
    );
  },

  /**
   * POST /internal/storage/move-to-cold
   */
  async moveItemsToCold(
    data: MoveToColdRequest,
    requestId?: string,
  ): Promise<MoveToColdResponse> {
    return makeProtectedRequest<MoveToColdResponse>(
      "POST",
      "/storage/move-to-cold",
      data,
      requestId,
    );
  },

  /** Durable intent before an object-store mutation. */
  async startStorageOperationSaga(
    data: StartStorageOperationSagaRequest,
    requestId?: string,
  ): Promise<StorageOperationSaga> {
    const response = await makeProtectedRequest<{ data: StorageOperationSaga }>(
      "POST",
      "/storage/operation-sagas",
      data,
      requestId,
    );
    return response.data;
  },

  /** Provider-side confirmation before CMS references are committed. */
  async markStorageSagaObjectApplied(
    sagaId: string,
    evidence: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/storage/operation-sagas/${encodeURIComponent(sagaId)}/object-applied`,
      { evidence },
      requestId,
    );
  },

  /**
   * POST /internal/storage/sweep-runs
   */
  async createSweepRun(
    data: CreateSweepRunRequest,
    requestId?: string,
  ): Promise<unknown> {
    return makeProtectedRequest<unknown>(
      "POST",
      "/storage/sweep-runs",
      data,
      requestId,
    );
  },

  /**
   * GET /internal/content-items/:id
   * Returns the full record needed by the quality worker (tier, media_url,
   * media_version, current profile id). Single source of truth — replaces
   * the prior pattern of deriving source key from `getStorageKey()` and
   * assuming primary tier.
   */
  async getContentItem(
    id: string,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<InternalContentItem> {
    return makeRequest<InternalContentItem>(
      "GET",
      `/content-items/${id}`,
      undefined,
      requestId,
      parentSignal,
    );
  },

  async getAtomizationInput(
    id: string,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<AtomizationInputResponse> {
    return makeRequest<AtomizationInputResponse>(
      "GET",
      `/content-items/${id}/atomization`,
      undefined,
      requestId,
      parentSignal,
    );
  },

  async listAtomizationCandidates(
    limit = 25,
    tenantId = "default",
    requestId?: string,
  ): Promise<ListAtomizationCandidatesResponse> {
    const params = new URLSearchParams({
      limit: String(limit),
      tenant_id: tenantId,
    });
    return makeRequest<ListAtomizationCandidatesResponse>(
      "GET",
      `/atomization/candidates?${params.toString()}`,
      undefined,
      requestId,
    );
  },

  async repairAtomizationLeaks(
    tenantId = "default",
    requestId?: string,
  ): Promise<AtomizationRepairResponse> {
    const params = new URLSearchParams({ tenant_id: tenantId });
    return makeProtectedRequest<AtomizationRepairResponse>(
      "POST",
      `/atomization/repair-leaks?${params.toString()}`,
      {},
      requestId,
    );
  },

  async saveAtomizationPlan(
    id: string,
    chapters: AtomizationChapter[],
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<{ chapters: unknown[] }> {
    return makeProtectedRequest<{ chapters: unknown[] }>(
      "POST",
      `/content-items/${id}/atomization/plan`,
      { chapters },
      requestId,
      parentSignal,
    );
  },

  async createAtomizedChildren(
    id: string,
    chapters: AtomizationChapter[],
    contentStage?: ContentStageCorrelation,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<{ children: AtomizedChildResponse[] }> {
    return makeProtectedRequest<{ children: AtomizedChildResponse[] }>(
      "POST",
      `/content-items/${id}/atomization/children`,
      { chapters, content_stage: contentStage },
      requestId,
      parentSignal,
    );
  },

  async reportAtomizationRun(
    id: string,
    data: AtomizationRunReportRequest,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<AtomizationRunReportResponse> {
    return makeProtectedRequest<AtomizationRunReportResponse>(
      "POST",
      `/content-items/${id}/atomization/runs`,
      data,
      requestId,
      parentSignal,
    );
  },

  async createArtifactManifest(
    input: Record<string, unknown>,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<ArtifactManifest> {
    return makeProtectedRequest<ArtifactManifest>(
      "POST",
      "/artifact-manifests",
      input,
      requestId,
      parentSignal,
    );
  },
  async transitionArtifactManifest(
    id: string,
    state: string,
    input: Record<string, unknown> = {},
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<ArtifactManifest> {
    return makeProtectedRequest<ArtifactManifest>(
      "POST",
      `/artifact-manifests/${encodeURIComponent(id)}/${state.replace(/_/g, "-")}`,
      { ...input, state },
      requestId,
      parentSignal,
    );
  },
  async getArtifactManifest(
    id: string,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<ArtifactManifest> {
    return makeProtectedRequest<ArtifactManifest>(
      "GET",
      `/artifact-manifests/${encodeURIComponent(id)}`,
      undefined,
      requestId,
      parentSignal,
    );
  },
  async listArtifactManifests(
    params: { state?: string; stale?: boolean; tenant_id?: string } = {},
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<{ manifests: ArtifactManifest[] }> {
    const query = new URLSearchParams();
    if (params.state) query.set("state", params.state);
    if (params.stale) query.set("stale", "true");
    if (params.tenant_id) query.set("tenant_id", params.tenant_id);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return makeProtectedRequest<{ manifests: ArtifactManifest[] }>(
      "GET",
      `/artifact-manifests${suffix}`,
      undefined,
      requestId,
      parentSignal,
    );
  },
  async resolveMediaDeliveryPolicy(
    params: {
      tenant_id: string;
      source_type: string;
      media_kind: "audio" | "video";
      suitability?: string;
      short_form?: boolean;
    },
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<{
    policy: import("./types.js").MediaDeliveryPolicy;
    matched_on: string;
  }> {
    const query = new URLSearchParams({
      tenant_id: params.tenant_id,
      source_type: params.source_type,
      media_kind: params.media_kind,
    });
    if (params.suitability) query.set("suitability", params.suitability);
    if (params.short_form === false) query.set("short_form", "false");
    return makeProtectedRequest(
      "GET",
      `/media-delivery/policies/resolve?${query.toString()}`,
      undefined,
      requestId,
      parentSignal,
    );
  },
  async createMediaRenditionGeneration(
    input: Record<string, unknown>,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<MediaRenditionGeneration> {
    return makeProtectedRequest<MediaRenditionGeneration>(
      "POST",
      "/media-rendition-generations",
      input,
      requestId,
      parentSignal,
    );
  },
  async transitionMediaRenditionGeneration(
    id: string,
    state: "running" | "verifying" | "failed" | "uncertain",
    input: Record<string, unknown>,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<MediaRenditionGeneration> {
    return makeProtectedRequest<MediaRenditionGeneration>(
      "POST",
      `/media-rendition-generations/${encodeURIComponent(id)}/${state}`,
      input,
      requestId,
      parentSignal,
    );
  },
  async activateMediaRenditionGeneration(
    id: string,
    input: Record<string, unknown>,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<MediaRenditionGeneration> {
    return makeProtectedRequest<MediaRenditionGeneration>(
      "POST",
      `/media-rendition-generations/${encodeURIComponent(id)}/activate`,
      input,
      requestId,
      parentSignal,
    );
  },
  async createMediaHLSPackage(
    input: Record<string, unknown>,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<import("./types.js").MediaHLSPackage> {
    return makeProtectedRequest(
      "POST",
      "/media-hls-packages",
      input,
      requestId,
      parentSignal,
    );
  },
  async verifyMediaHLSPackage(
    id: string,
    input: Record<string, unknown>,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<import("./types.js").MediaHLSPackage> {
    return makeProtectedRequest(
      "POST",
      `/media-hls-packages/${encodeURIComponent(id)}/verify`,
      input,
      requestId,
      parentSignal,
    );
  },
  async createMediaHLSAccessPoint(
    input: Record<string, unknown>,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<import("./types.js").MediaHLSAccessPoint> {
    return makeProtectedRequest(
      "POST",
      "/media-hls-access-points",
      input,
      requestId,
      parentSignal,
    );
  },
  async createTranscriptionGeneration(
    input: Record<string, unknown>,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<{ generation: TranscriptionGeneration }> {
    return makeProtectedRequest<{ generation: TranscriptionGeneration }>(
      "POST",
      "/transcription-generations",
      input,
      requestId,
      parentSignal,
    );
  },
  async claimTranscriptionSegment(requestId?: string): Promise<{
    unit: TranscriptionSegmentUnit;
    generation: TranscriptionGeneration;
  } | null> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      "/transcription-segments/claim",
      {},
      requestId,
    );
    if (!raw) return null;
    const value = raw as {
      unit: TranscriptionSegmentUnit;
      generation: TranscriptionGeneration;
    };
    return value.unit && value.generation ? value : null;
  },
  async transitionTranscriptionSegment(
    id: string,
    state: string,
    input: Record<string, unknown>,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/transcription-segments/${encodeURIComponent(id)}/${state}`,
      input,
      requestId,
      parentSignal,
    );
  },
  async heartbeatTranscriptionSegment(
    id: string,
    claimToken: string,
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/transcription-segments/${encodeURIComponent(id)}/heartbeat`,
      { claim_token: claimToken },
      requestId,
    );
  },
  async finalizeTranscriptionGeneration(
    id: string,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<{ transcript_id: string }> {
    return makeProtectedRequest<{ transcript_id: string }>(
      "POST",
      `/transcription-generations/${encodeURIComponent(id)}/finalize`,
      {},
      requestId,
      parentSignal,
    );
  },
  async createAtomizationGeneration(
    input: Record<string, unknown>,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<{ generation: AtomizationGeneration }> {
    return makeProtectedRequest<{ generation: AtomizationGeneration }>(
      "POST",
      "/atomization-generations",
      input,
      requestId,
      parentSignal,
    );
  },
  async claimAtomizationChapterUnit(
    requestId?: string,
    generationId?: string,
  ): Promise<{
    unit: AtomizationChapterUnit;
    generation: AtomizationGeneration;
  } | null> {
    const raw = await makeProtectedRequest<unknown>(
      "POST",
      "/atomization-chapter-units/claim",
      generationId ? { generation_id: generationId } : {},
      requestId,
    );
    if (!raw) return null;
    const value = raw as {
      unit: AtomizationChapterUnit;
      generation: AtomizationGeneration;
    };
    return value.unit && value.generation ? value : null;
  },
  async transitionAtomizationChapterUnit(
    id: string,
    state: string,
    input: Record<string, unknown>,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/atomization-chapter-units/${encodeURIComponent(id)}/${state}`,
      input,
      requestId,
      parentSignal,
    );
  },
  async heartbeatAtomizationChapterUnit(
    id: string,
    claimToken: string,
    requestId?: string,
  ): Promise<void> {
    await makeProtectedRequest(
      "POST",
      `/atomization-chapter-units/${encodeURIComponent(id)}/heartbeat`,
      { claim_token: claimToken },
      requestId,
    );
  },
  async listAtomizationChapterUnits(
    generationId: string,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<{ units: AtomizationChapterUnit[] }> {
    return makeProtectedRequest<{ units: AtomizationChapterUnit[] }>(
      "GET",
      `/atomization-generations/${encodeURIComponent(generationId)}/units`,
      undefined,
      requestId,
      parentSignal,
    );
  },
  async finalizeAtomizationGeneration(
    generationId: string,
    contentStage?: ContentStageCorrelation,
    requestId?: string,
    parentSignal?: AbortSignal,
  ): Promise<{
    children: AtomizedChildResponse[];
    generation: AtomizationGeneration;
  }> {
    return makeProtectedRequest<{
      children: AtomizedChildResponse[];
      generation: AtomizationGeneration;
    }>(
      "POST",
      `/atomization-generations/${encodeURIComponent(generationId)}/finalize`,
      contentStage ? { content_stage: contentStage } : {},
      requestId,
      parentSignal,
    );
  },

  // ---------------------------------------------------------------
  // Quality / Ingest configuration
  //
  // Phase 7: ingest profile resolution + per-item quality patch.
  // (rule / candidates / history endpoints were removed; re-encoding old
  // content is now driven by Storage policies with archive_action='re_encode'.)
  // ---------------------------------------------------------------

  /**
   * GET /internal/quality/profiles/:id
   * Used by the re-encode worker (invoked from Storage sweeps) when the
   * storage policy specifies an explicit re_encode_target_profile_id.
   */
  async getQualityProfile(
    id: number,
    requestId?: string,
  ): Promise<QualityProfile> {
    return makeRequest<QualityProfile>(
      "GET",
      `/quality/profiles/${id}`,
      undefined,
      requestId,
    );
  },

  /**
   * GET /internal/quality/profiles/resolve?tenant_id=X&source_type=Y
   *
   * Returns the most-specific matching profile (and the resolution-rung tag).
   * Returns null when CMS responds 404 (no rung matched and no global
   * default exists) — caller falls back to DEFAULT_ENCODE_PROFILE.
   */
  async resolveQualityProfile(
    params: { tenant_id?: string; source_type?: string; preset_key?: string },
    requestId?: string,
  ): Promise<ResolveProfileResponse | null> {
    const qs = new URLSearchParams();
    if (params.tenant_id) qs.set("tenant_id", params.tenant_id);
    if (params.source_type) qs.set("source_type", params.source_type);
    if (params.preset_key) qs.set("preset_key", params.preset_key);
    const query = qs.toString() ? `?${qs.toString()}` : "";
    try {
      return await makeRequest<ResolveProfileResponse>(
        "GET",
        `/quality/profiles/resolve${query}`,
        undefined,
        requestId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404")) return null;
      throw err;
    }
  },

  /**
   * PATCH /internal/content-items/:id/quality
   */
  async updateContentItemQuality(
    id: string,
    data: UpdateContentItemQualityRequest,
    requestId?: string,
  ): Promise<UpdateContentItemQualityResponse> {
    return makeProtectedRequest<UpdateContentItemQualityResponse>(
      "PATCH",
      `/content-items/${id}/quality`,
      data,
      requestId,
    );
  },

  /**
   * POST /internal/storage/artifact-events
   * Execution ledger for storage/quality actions. Best effort from workers:
   * failures are logged by callers but should not hide the primary result.
   */
  async recordStorageArtifactEvent(
    data: StorageArtifactEventRequest,
    requestId?: string,
  ): Promise<{ success: boolean; event_id: string }> {
    return makeProtectedRequest<{ success: boolean; event_id: string }>(
      "POST",
      "/storage/artifact-events",
      data,
      requestId,
    );
  },

  // ---------------------------------------------------------------
  // Storage operations telemetry
  // ---------------------------------------------------------------

  /**
   * POST /internal/storage/op-metrics
   * Hourly flush from the SDK middleware counter. CMS UPSERTs by adding
   * `count` to the existing daily row, so re-flushing the same delta is
   * NOT idempotent — caller must already have drained its in-memory bucket.
   */
  async writeOpMetrics(
    data: WriteOpMetricsRequest,
    requestId?: string,
  ): Promise<{ success: boolean; written: number }> {
    return makeProtectedRequest<{ success: boolean; written: number }>(
      "POST",
      "/storage/op-metrics",
      data,
      requestId,
    );
  },

  /**
   * GET /internal/storage/op-budget?tenant_id=X
   * Used by the storage + quality sweepers to short-circuit before
   * enqueueing work when the soft cap has been hit.
   */
  async getStorageOpBudget(
    tenantId: string,
    requestId?: string,
  ): Promise<OpBudgetStatus> {
    const qs = `?tenant_id=${encodeURIComponent(tenantId)}`;
    return makeRequest<OpBudgetStatus>(
      "GET",
      `/storage/op-budget${qs}`,
      undefined,
      requestId,
    );
  },

  async putPipelineLaneSnapshot(data: {
    tenant_id?: string;
    lane: "news" | "pods";
    required_queue_depth: number;
    optional_queue_depth: number;
    required_oldest_age_seconds: number;
    optional_oldest_age_seconds: number;
    dlq_delta: number;
    failure_classes?: Record<string, number>;
    stage_counts?: Record<string, number>;
    enrichment_counts?: Record<string, number>;
    process_metrics?: Record<string, unknown>;
    resource_metrics?: Record<string, unknown>;
    captured_at?: string;
  }, requestId?: string): Promise<unknown> {
    return makeProtectedRequest("PUT", `/pipeline-lanes/${data.lane}/snapshot`, data, requestId);
  },

  /**
   * Get the circuit breaker instance (for testing/monitoring)
   */
  getCircuitBreaker(): CircuitBreaker {
    return cmsCircuitBreaker;
  },
};

// Export types
export * from "./types.js";
