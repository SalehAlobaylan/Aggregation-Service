/**
 * CMS API Client with circuit breaker protection
 */
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import { logger, createLogger } from '../observability/logger.js';
import { CircuitBreaker } from './circuit-breaker.js';
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
} from './types.js';

// Circuit breaker for CMS calls
const cmsCircuitBreaker = new CircuitBreaker({
    name: 'cms',
    failureThreshold: 5,
    resetTimeout: 30000,
    halfOpenRequests: 3,
});

const CMS_REQUEST_TIMEOUT_MS = 10_000;
const CMS_MAX_SUCCESS_BODY_BYTES = 2 << 20;
const CMS_MAX_ERROR_BODY_BYTES = 16 << 10;

export class CMSRequestError extends Error {
    constructor(
        readonly status: number,
        readonly retryable: boolean,
    ) {
        super(`CMS request failed with status ${status}`);
        this.name = 'CMSRequestError';
    }
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
    if (!response.body) return '';
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
                throw new Error('CMS response exceeded maximum body size');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
}

function countsAsCMSAvailabilityFailure(error: unknown): boolean {
    if (error instanceof CMSRequestError) return error.retryable;
    // Fetch transport and deadline errors indicate dependency availability;
    // parser/validation errors and ordinary 4xx responses do not.
    return error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError');
}

/**
 * Build request headers with auth and tracing
 */
function buildHeaders(requestId?: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.cmsServiceToken}`,
        'X-Service-Name': 'aggregation-service',
        'X-Request-ID': requestId || uuidv4(),
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
            ? AbortSignal.any([parentSignal, AbortSignal.timeout(CMS_REQUEST_TIMEOUT_MS)])
            : AbortSignal.timeout(CMS_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
        // Drain only a small bounded prefix so keep-alive resources are not
        // retained, but never return or log upstream-controlled error text.
        await readBoundedText(response, CMS_MAX_ERROR_BODY_BYTES).catch(() => '');
        reqLogger.error(`CMS API error: ${response.status}`, undefined, {
            status: response.status,
        });
        throw new CMSRequestError(response.status, response.status === 429 || response.status >= 500);
    }

    const raw = await readBoundedText(response, CMS_MAX_SUCCESS_BODY_BYTES);
    let data: T;
    try {
        data = JSON.parse(raw) as T;
    } catch {
        throw new Error('CMS returned invalid JSON');
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
): Promise<T> {
    return cmsCircuitBreaker.execute(
        () => makeRequest<T>(method, path, body, requestId, parentSignal),
        countsAsCMSAvailabilityFailure,
    );
}

/**
 * CMS API Client
 */
export const cmsClient = {
	async redundancyPrecheck(candidates: Array<{ title: string; duration_sec?: number; source_url?: string }>, requestId?: string): Promise<{ candidates: Array<{ verdict: 'clear' | 'exact_identity' | 'likely_duplicate'; existing_item_id?: string; confidence: number; reasons: string[] }> }> {
		return makeProtectedRequest('POST', '/redundancy/precheck', { candidates }, requestId);
	},
    /**
     * Ping CMS for health check
     * Uses a configurable path, defaults to /health
     */
    async ping(requestId?: string): Promise<boolean> {
        try {
            const pingPath = process.env['CMS_PING_PATH'] || '/health';
            await cmsCircuitBreaker.execute(async () => {
                const url = `${config.cmsBaseUrl.replace('/internal', '')}${pingPath}`;
                const response = await fetch(url, {
                    method: 'GET',
                    headers: buildHeaders(requestId),
                    signal: AbortSignal.timeout(CMS_REQUEST_TIMEOUT_MS),
                });
                try {
                    if (!response.ok) {
                        throw new CMSRequestError(response.status, response.status === 429 || response.status >= 500);
                    }
                    await readBoundedText(response, CMS_MAX_ERROR_BODY_BYTES);
                } finally {
                    response.body?.cancel().catch(() => undefined);
                }
            }, countsAsCMSAvailabilityFailure);
            return true;
        } catch (error) {
            logger.warn('CMS ping failed', { error });
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
        requestId?: string
    ): Promise<CreateContentItemResponse> {
        return makeProtectedRequest<CreateContentItemResponse>(
            'POST',
            '/content-items',
            data,
            requestId
        );
    },

    /**
     * Post discovered source candidates to CMS for admin review.
     * POST /internal/source-suggestions
     */
    async postSourceSuggestions(
        data: { tenantId?: string; profileId?: string; candidates: unknown[] },
        requestId?: string
    ): Promise<{ upserted: number; skipped: number }> {
        return makeProtectedRequest<{ upserted: number; skipped: number }>(
            'POST',
            '/source-suggestions',
            {
                tenant_id: data.tenantId,
                profile_id: data.profileId,
                candidates: data.candidates,
            },
            requestId
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
        return makeRequest('GET', '/discovery/config', undefined, requestId);
    },

    /**
     * Source-graph signals + ledger write-back (Slice 4).
     */
    async getCorpusCitations(requestId?: string): Promise<{ data: { domain: string; count: number; recent_count: number }[] }> {
        return makeRequest('GET', '/intel/corpus-citations', undefined, requestId);
    },
    async getApprovedSourcePages(requestId?: string): Promise<{ data: { host: string; site_url: string; feed_url: string }[] }> {
        return makeRequest('GET', '/intel/approved-source-pages', undefined, requestId);
    },
    async getApprovedTelegramChannels(requestId?: string): Promise<{ data: { username: string }[] }> {
        return makeRequest('GET', '/intel/approved-telegram-channels', undefined, requestId);
    },
    async getApprovedTwitterHandles(requestId?: string): Promise<{ data: { username: string }[] }> {
        return makeRequest('GET', '/intel/approved-twitter-handles', undefined, requestId);
    },
    async getApprovedYouTubeChannels(requestId?: string): Promise<{ data: { channel: string }[] }> {
        return makeRequest('GET', '/intel/approved-youtube-channels', undefined, requestId);
    },
    async getApprovedPodcastFeeds(requestId?: string): Promise<{ data: { feed_url: string }[] }> {
        return makeRequest('GET', '/intel/approved-podcast-feeds', undefined, requestId);
    },
    async postCandidates(
        data: { candidates: unknown[]; edges: { from_host: string; to_host: string; weight: number }[] },
        requestId?: string
    ): Promise<{ candidates: number; edges: number; promoted: number }> {
        return makeProtectedRequest('POST', '/intel/candidates', data, requestId);
    },

    /**
     * List enabled discovery profiles for the scheduled sweep fan-out.
     * GET /internal/discovery/profiles?enabled=true
     */
    async listEnabledDiscoveryProfiles(requestId?: string): Promise<{
        data: Array<{ id: string; name: string; description?: string; keywords?: string[]; languages?: string[]; category?: string; max_suggestions_per_run?: number }>;
    }> {
        return makeRequest('GET', '/discovery/profiles?enabled=true', undefined, requestId);
    },

    async getCirculationPolicy(tenantId = 'default', requestId?: string): Promise<NewsCirculationPolicy> {
        return makeRequest('GET', `/circulation/policy?tenant_id=${encodeURIComponent(tenantId)}`, undefined, requestId);
    },

    async claimCirculationSources(
        tenantId = 'default',
        limit = 20,
        force = false,
        requestId?: string,
        recovery?: { runId: string; manifestHash: string; lane: 'news' | 'media'; sourceIds: string[]; lookbackHours: number; maxItems: number; preserveCheckpoints: true }
    ): Promise<ClaimCirculationSourcesResponse> {
        const recoveryQuery = recovery ? `&recovery_lane=${recovery.lane}&recovery_run_id=${encodeURIComponent(recovery.runId)}&recovery_manifest_hash=${encodeURIComponent(recovery.manifestHash)}&recovery_source_ids=${encodeURIComponent(recovery.sourceIds.join(','))}&recovery_lookback_hours=${recovery.lookbackHours}&recovery_max_items=${recovery.maxItems}&preserve_checkpoints=true` : '';
        return makeProtectedRequest(
            'POST',
            `/circulation/claim-sources?tenant_id=${encodeURIComponent(tenantId)}&limit=${limit}&force=${force ? 'true' : 'false'}${recoveryQuery}`,
            {},
            requestId
        );
    },

    async claimMediaCirculationSources(
        tenantId = 'default',
        limit = 0,
        requestId?: string,
    ): Promise<ClaimMediaCirculationSourcesResponse> {
        return makeProtectedRequest(
            'POST',
            `/circulation/claim-sources?lane=media&tenant_id=${encodeURIComponent(tenantId)}&limit=${limit}`,
            {},
            requestId,
        );
    },

    async reportSourceRun(data: ReportSourceRunRequest, requestId?: string, parentSignal?: AbortSignal): Promise<void> {
        await makeProtectedRequest('POST', '/circulation/source-runs', data, requestId, parentSignal);
    },

	async acceptSourceRunRequest(sourceRunRequestId: string, jobId: string, requestId?: string): Promise<void> {
		await makeProtectedRequest('POST', `/source-run-requests/${encodeURIComponent(sourceRunRequestId)}/accepted`, { job_id: jobId }, requestId);
	},

    /**
     * Update an existing content item
     * PUT /internal/content-items/:id
     */
    async updateContentItem(
        id: string,
        data: UpdateContentItemRequest,
        requestId?: string
    ): Promise<ContentItem> {
        return makeProtectedRequest<ContentItem>(
            'PUT',
            `/content-items/${id}`,
            data,
            requestId
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
            'PATCH',
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
            'PATCH',
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
        requestId?: string
    ): Promise<CreateTranscriptResponse> {
        return makeProtectedRequest<CreateTranscriptResponse>(
            'POST',
            '/transcripts',
            data,
            requestId
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
            'POST',
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
            'PATCH',
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
        requestId?: string
    ): Promise<void> {
        await makeProtectedRequest<void>(
            'PATCH',
            `/content-items/${contentItemId}/transcript`,
            data,
            requestId
        );
    },

    /**
     * Update content item embedding
     * PATCH /internal/content-items/:id/embedding
     */
    async updateEmbedding(
        id: string,
        data: UpdateEmbeddingRequest,
        requestId?: string
    ): Promise<void> {
        await makeProtectedRequest<void>(
            'PATCH',
            `/content-items/${id}/embedding`,
            data,
            requestId
        );
    },

    /**
     * List content items with optional filters
     * GET /internal/content-items?status=FAILED&source=TELEGRAM&ids=a,b&limit=100&page=1
     */
    async listContentItems(
        params: { status?: string; source?: string; ids?: string[]; limit?: number; page?: number },
        requestId?: string
    ): Promise<InternalContentListResponse> {
        const qs = new URLSearchParams();
        if (params.status) qs.set('status', params.status);
        if (params.source) qs.set('source', params.source);
        if (params.ids?.length) qs.set('ids', params.ids.join(','));
        if (params.limit) qs.set('limit', String(params.limit));
        if (params.page) qs.set('page', String(params.page));
        const query = qs.toString() ? `?${qs.toString()}` : '';
        return makeRequest<InternalContentListResponse>('GET', `/content-items${query}`, undefined, requestId);
    },

    /**
     * GET /internal/content-items/missing-embedding?limit=N
     * READY items still lacking a dense embedding — drives the reconciliation
     * sweep (H2 backstop).
     */
    async listMissingEmbedding(
        limit: number,
        requestId?: string
    ): Promise<ListMissingEmbeddingResponse> {
        return makeRequest<ListMissingEmbeddingResponse>(
            'GET',
            `/content-items/missing-embedding?limit=${limit}`,
            undefined,
            requestId
        );
    },

    // ---------------------------------------------------------------
    // Storage management
    // ---------------------------------------------------------------

    /**
     * GET /internal/storage/policies
     */
    async listStoragePolicies(requestId?: string): Promise<ListStoragePoliciesResponse> {
        return makeRequest<ListStoragePoliciesResponse>(
            'GET',
            '/storage/policies',
            undefined,
            requestId
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
            archive_action?: 'delete' | 'move_to_cold' | 're_encode' | string;
        },
        requestId?: string
    ): Promise<ListStorageCandidatesResponse> {
        const qs = new URLSearchParams();
        qs.set('tenant_id', params.tenant_id);
        if (params.min_age_days !== undefined) qs.set('min_age_days', String(params.min_age_days));
        if (params.max_view_count !== undefined) qs.set('max_view_count', String(params.max_view_count));
        if (params.limit !== undefined) qs.set('limit', String(params.limit));
        if (params.delete_failed_immediately !== undefined) qs.set('delete_failed_immediately', String(params.delete_failed_immediately));
        if (params.max_bytes !== undefined) qs.set('max_bytes', String(params.max_bytes));
        if (params.ids?.length) qs.set('ids', params.ids.join(','));
        if (params.include_atomized_parents !== undefined) qs.set('include_atomized_parents', String(params.include_atomized_parents));
        if (params.archive_action !== undefined) qs.set('archive_action', String(params.archive_action));
        return makeRequest<ListStorageCandidatesResponse>(
            'GET',
            `/storage/candidates?${qs.toString()}`,
            undefined,
            requestId
        );
    },

    /**
     * POST /internal/storage/archive
     */
    async archiveItems(
        data: ArchiveItemsRequest,
        requestId?: string
    ): Promise<ArchiveItemsResponse> {
        return makeProtectedRequest<ArchiveItemsResponse>(
            'POST',
            '/storage/archive',
            data,
            requestId
        );
    },

    /**
     * POST /internal/storage/move-to-cold
     */
    async moveItemsToCold(
        data: MoveToColdRequest,
        requestId?: string
    ): Promise<MoveToColdResponse> {
        return makeProtectedRequest<MoveToColdResponse>(
            'POST',
            '/storage/move-to-cold',
            data,
            requestId
        );
    },

    /** Durable intent before an object-store mutation. */
    async startStorageOperationSaga(
        data: StartStorageOperationSagaRequest,
        requestId?: string,
    ): Promise<StorageOperationSaga> {
        const response = await makeProtectedRequest<{ data: StorageOperationSaga }>(
            'POST',
            '/storage/operation-sagas',
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
            'POST',
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
        requestId?: string
    ): Promise<unknown> {
        return makeProtectedRequest<unknown>(
            'POST',
            '/storage/sweep-runs',
            data,
            requestId
        );
    },

    /**
     * GET /internal/content-items/:id
     * Returns the full record needed by the quality worker (tier, media_url,
     * media_version, current profile id). Single source of truth — replaces
     * the prior pattern of deriving source key from `getStorageKey()` and
     * assuming primary tier.
     */
    async getContentItem(id: string, requestId?: string, parentSignal?: AbortSignal): Promise<InternalContentItem> {
        return makeRequest<InternalContentItem>(
            'GET',
            `/content-items/${id}`,
            undefined,
            requestId,
            parentSignal,
        );
    },

    async getAtomizationInput(id: string, requestId?: string, parentSignal?: AbortSignal): Promise<AtomizationInputResponse> {
        return makeRequest<AtomizationInputResponse>(
            'GET',
            `/content-items/${id}/atomization`,
            undefined,
            requestId,
            parentSignal,
        );
    },

    async listAtomizationCandidates(limit = 25, tenantId = 'default', requestId?: string): Promise<ListAtomizationCandidatesResponse> {
        const params = new URLSearchParams({
            limit: String(limit),
            tenant_id: tenantId,
        });
        return makeRequest<ListAtomizationCandidatesResponse>(
            'GET',
            `/atomization/candidates?${params.toString()}`,
            undefined,
            requestId
        );
    },

    async repairAtomizationLeaks(tenantId = 'default', requestId?: string): Promise<AtomizationRepairResponse> {
        const params = new URLSearchParams({ tenant_id: tenantId });
        return makeProtectedRequest<AtomizationRepairResponse>(
            'POST',
            `/atomization/repair-leaks?${params.toString()}`,
            {},
            requestId
        );
    },

    async saveAtomizationPlan(
        id: string,
        chapters: AtomizationChapter[],
        requestId?: string,
        parentSignal?: AbortSignal,
    ): Promise<{ chapters: unknown[] }> {
        return makeProtectedRequest<{ chapters: unknown[] }>(
            'POST',
            `/content-items/${id}/atomization/plan`,
            { chapters },
            requestId,
            parentSignal,
        );
    },

    async createAtomizedChildren(
        id: string,
        chapters: AtomizationChapter[],
        requestId?: string,
        parentSignal?: AbortSignal,
    ): Promise<{ children: AtomizedChildResponse[] }> {
        return makeProtectedRequest<{ children: AtomizedChildResponse[] }>(
            'POST',
            `/content-items/${id}/atomization/children`,
            { chapters },
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
            'POST',
            `/content-items/${id}/atomization/runs`,
            data,
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
    async getQualityProfile(id: number, requestId?: string): Promise<QualityProfile> {
        return makeRequest<QualityProfile>(
            'GET',
            `/quality/profiles/${id}`,
            undefined,
            requestId
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
        requestId?: string
    ): Promise<ResolveProfileResponse | null> {
        const qs = new URLSearchParams();
        if (params.tenant_id) qs.set('tenant_id', params.tenant_id);
        if (params.source_type) qs.set('source_type', params.source_type);
        if (params.preset_key) qs.set('preset_key', params.preset_key);
        const query = qs.toString() ? `?${qs.toString()}` : '';
        try {
            return await makeRequest<ResolveProfileResponse>(
                'GET',
                `/quality/profiles/resolve${query}`,
                undefined,
                requestId
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('404')) return null;
            throw err;
        }
    },

    /**
     * PATCH /internal/content-items/:id/quality
     */
    async updateContentItemQuality(
        id: string,
        data: UpdateContentItemQualityRequest,
        requestId?: string
    ): Promise<UpdateContentItemQualityResponse> {
        return makeProtectedRequest<UpdateContentItemQualityResponse>(
            'PATCH',
            `/content-items/${id}/quality`,
            data,
            requestId
        );
    },

    /**
     * POST /internal/storage/artifact-events
     * Execution ledger for storage/quality actions. Best effort from workers:
     * failures are logged by callers but should not hide the primary result.
     */
    async recordStorageArtifactEvent(
        data: StorageArtifactEventRequest,
        requestId?: string
    ): Promise<{ success: boolean; event_id: string }> {
        return makeProtectedRequest<{ success: boolean; event_id: string }>(
            'POST',
            '/storage/artifact-events',
            data,
            requestId
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
    async writeOpMetrics(data: WriteOpMetricsRequest, requestId?: string): Promise<{ success: boolean; written: number }> {
        return makeProtectedRequest<{ success: boolean; written: number }>(
            'POST',
            '/storage/op-metrics',
            data,
            requestId
        );
    },

    /**
     * GET /internal/storage/op-budget?tenant_id=X
     * Used by the storage + quality sweepers to short-circuit before
     * enqueueing work when the soft cap has been hit.
     */
    async getStorageOpBudget(tenantId: string, requestId?: string): Promise<OpBudgetStatus> {
        const qs = `?tenant_id=${encodeURIComponent(tenantId)}`;
        return makeRequest<OpBudgetStatus>(
            'GET',
            `/storage/op-budget${qs}`,
            undefined,
            requestId
        );
    },

    /**
     * Get the circuit breaker instance (for testing/monitoring)
     */
    getCircuitBreaker(): CircuitBreaker {
        return cmsCircuitBreaker;
    },
};

// Export types
export * from './types.js';
