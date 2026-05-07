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
    QualityProfile,
    QualityRule,
    QualityCandidatesResponse,
    WriteQualityHistoryRequest,
    UpdateContentItemQualityRequest,
    UpdateContentItemQualityResponse,
} from './types.js';

// Circuit breaker for CMS calls
const cmsCircuitBreaker = new CircuitBreaker({
    name: 'cms',
    failureThreshold: 5,
    resetTimeout: 30000,
    halfOpenRequests: 3,
});

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
    requestId?: string
): Promise<T> {
    const url = `${config.cmsBaseUrl}${path}`;
    const reqId = requestId || uuidv4();
    const reqLogger = createLogger({ requestId: reqId });

    reqLogger.debug(`CMS API ${method} ${path}`);

    const response = await fetch(url, {
        method,
        headers: buildHeaders(reqId),
        body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
        const errorBody = await response.text();
        reqLogger.error(`CMS API error: ${response.status}`, undefined, {
            status: response.status,
            body: errorBody,
        });
        throw new Error(`CMS API error: ${response.status} - ${errorBody}`);
    }

    const data = await response.json() as T;
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
    requestId?: string
): Promise<T> {
    return cmsCircuitBreaker.execute(() => makeRequest<T>(method, path, body, requestId));
}

/**
 * CMS API Client
 */
export const cmsClient = {
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
                });
                if (!response.ok) {
                    throw new Error(`CMS ping failed: ${response.status}`);
                }
            });
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
        requestId?: string
    ): Promise<void> {
        await makeProtectedRequest<void>(
            'PATCH',
            `/content-items/${id}/status`,
            data,
            requestId
        );
    },

    /**
     * Update content item artifacts (media_url, thumbnail_url, duration_sec)
     * PATCH /internal/content-items/:id/artifacts
     */
    async updateArtifacts(
        id: string,
        data: UpdateArtifactsRequest,
        requestId?: string
    ): Promise<void> {
        await makeProtectedRequest<void>(
            'PATCH',
            `/content-items/${id}/artifacts`,
            data,
            requestId
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
     * GET /internal/content-items?status=FAILED&source=TELEGRAM&limit=100&page=1
     */
    async listContentItems(
        params: { status?: string; source?: string; limit?: number; page?: number },
        requestId?: string
    ): Promise<InternalContentListResponse> {
        const qs = new URLSearchParams();
        if (params.status) qs.set('status', params.status);
        if (params.source) qs.set('source', params.source);
        if (params.limit) qs.set('limit', String(params.limit));
        if (params.page) qs.set('page', String(params.page));
        const query = qs.toString() ? `?${qs.toString()}` : '';
        return makeRequest<InternalContentListResponse>('GET', `/content-items${query}`, undefined, requestId);
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

    // ---------------------------------------------------------------
    // Quality management
    // ---------------------------------------------------------------

    /**
     * GET /internal/quality/rules?enabled=true
     */
    async listQualityRules(
        params: { enabled?: boolean } = {},
        requestId?: string
    ): Promise<{ data: QualityRule[] }> {
        const qs = new URLSearchParams();
        if (params.enabled !== undefined) qs.set('enabled', String(params.enabled));
        const query = qs.toString() ? `?${qs.toString()}` : '';
        return makeRequest<{ data: QualityRule[] }>(
            'GET',
            `/quality/rules${query}`,
            undefined,
            requestId
        );
    },

    /**
     * GET /internal/quality/profiles/:id
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
     * GET /internal/quality/profiles/default?tenant_id=X
     * Returns null if no default is configured (404 from CMS).
     */
    async getDefaultQualityProfile(tenantId?: string, requestId?: string): Promise<QualityProfile | null> {
        const qs = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : '';
        try {
            return await makeRequest<QualityProfile>(
                'GET',
                `/quality/profiles/default${qs}`,
                undefined,
                requestId
            );
        } catch (err) {
            // 404 → no default configured. Caller falls back to DEFAULT_ENCODE_PROFILE.
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('404')) return null;
            throw err;
        }
    },

    /**
     * GET /internal/quality/candidates?rule_id=N&tenant_id=X&limit=K
     */
    async listQualityCandidates(
        params: { rule_id: number; tenant_id?: string; limit?: number },
        requestId?: string
    ): Promise<QualityCandidatesResponse> {
        const qs = new URLSearchParams();
        qs.set('rule_id', String(params.rule_id));
        if (params.tenant_id) qs.set('tenant_id', params.tenant_id);
        if (params.limit) qs.set('limit', String(params.limit));
        return makeRequest<QualityCandidatesResponse>(
            'GET',
            `/quality/candidates?${qs.toString()}`,
            undefined,
            requestId
        );
    },

    /**
     * POST /internal/quality/history
     */
    async writeQualityHistory(
        data: WriteQualityHistoryRequest,
        requestId?: string
    ): Promise<{ id: number }> {
        return makeProtectedRequest<{ id: number }>(
            'POST',
            '/quality/history',
            data,
            requestId
        );
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
     * Get the circuit breaker instance (for testing/monitoring)
     */
    getCircuitBreaker(): CircuitBreaker {
        return cmsCircuitBreaker;
    },
};

// Export types
export * from './types.js';
