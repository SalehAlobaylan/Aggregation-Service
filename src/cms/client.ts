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
     * Get the circuit breaker instance (for testing/monitoring)
     */
    getCircuitBreaker(): CircuitBreaker {
        return cmsCircuitBreaker;
    },
};

// Export types
export * from './types.js';
