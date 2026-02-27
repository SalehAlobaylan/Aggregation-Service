/**
 * Admin routes for manual triggers and inspection
 */
import { FastifyInstance } from 'fastify';
import { scheduler } from '../../services/scheduler.service.js';
import { getQueue, QUEUE_NAMES } from '../../queues/index.js';
import { rateLimiter } from '../../services/rate-limiter.js';
import { itunesSearch } from '../../services/itunes-search.js';
import { logger } from '../../observability/logger.js';
import type { SourceType } from '../../queues/schemas.js';
import { verifyAdminAuth } from '../plugins/admin-auth.js';
import { feedDiscoveryService } from '../../services/feed-discovery.service.js';
import { fetchFromSource, getSupportedSourceTypes } from '../../fetchers/index.js';
import { normalizeBatch } from '../../normalizers/index.js';

interface TriggerBody {
    sourceType: SourceType;
    url: string;
    name?: string;
    settings?: Record<string, unknown>;
}

interface TriggerResponse {
    success: boolean;
    jobId?: string;
    message: string;
}

interface QueueStatsResponse {
    queue: string;
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
}

interface JobResponse {
    id: string;
    name: string;
    data: unknown;
    state: string;
    progress: unknown;
    attemptsMade: number;
    failedReason?: string;
    processedOn?: number;
    finishedOn?: number;
    timestamp: number;
}

interface DiscoverFeedsBody {
    url: string;
}

interface DiscoverFeedsResponse {
    success: boolean;
    feeds: Array<{
        url: string;
        title?: string;
        type: 'RSS' | 'ATOM' | 'XML';
    }>;
    message: string;
}

interface PreviewSourceBody {
    sourceType: SourceType;
    url: string;
    name?: string;
    settings?: Record<string, unknown>;
    limit?: number;
}

interface PreviewSourceResponse {
    success: boolean;
    message: string;
    fetched: number;
    normalized: number;
    skipped: number;
    errors: number;
    items: Array<{
        idempotencyKey: string;
        type: string;
        title: string;
        excerpt: string | null;
        author: string | null;
        originalUrl: string;
        publishedAt: string | null;
    }>;
}

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
    /**
     * Discover feed URLs from a website URL
     * POST /admin/discover
     */
    fastify.post<{ Body: DiscoverFeedsBody; Reply: DiscoverFeedsResponse }>(
        '/admin/discover',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { url } = request.body;
            if (!url || !url.trim()) {
                return reply.status(400).send({
                    success: false,
                    feeds: [],
                    message: 'url is required',
                });
            }
            if (url.trim().length > 2048) {
                return reply.status(400).send({
                    success: false,
                    feeds: [],
                    message: 'url is too long',
                });
            }

            const rateCheck = await rateLimiter.consumeRateLimit('RSS', `discover:${request.ip}`);
            if (!rateCheck.allowed) {
                return reply.status(429).send({
                    success: false,
                    feeds: [],
                    message: 'rate limit exceeded for discovery requests',
                });
            }

            try {
                const feeds = await feedDiscoveryService.discoverFeeds(url);
                return reply.send({
                    success: true,
                    feeds,
                    message: feeds.length > 0 ? 'Feed candidates found' : 'No feeds discovered for this URL',
                });
            } catch (error) {
                logger.error('Feed discovery failed', error, { url });
                return reply.status(500).send({
                    success: false,
                    feeds: [],
                    message: error instanceof Error ? error.message : 'Failed to discover feeds',
                });
            }
        }
    );

    /**
     * Preview source ingestion without writing to CMS
     * POST /admin/preview
     */
    fastify.post<{ Body: PreviewSourceBody; Reply: PreviewSourceResponse }>(
        '/admin/preview',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { sourceType, url, name, settings, limit = 10 } = request.body;
            if (!sourceType || !url) {
                return reply.status(400).send({
                    success: false,
                    message: 'sourceType and url are required',
                    fetched: 0,
                    normalized: 0,
                    skipped: 0,
                    errors: 0,
                    items: [],
                });
            }
            if (!getSupportedSourceTypes().includes(sourceType)) {
                return reply.status(400).send({
                    success: false,
                    message: `unsupported sourceType: ${sourceType}`,
                    fetched: 0,
                    normalized: 0,
                    skipped: 0,
                    errors: 1,
                    items: [],
                });
            }
            if (url.trim().length > 2048) {
                return reply.status(400).send({
                    success: false,
                    message: 'url is too long',
                    fetched: 0,
                    normalized: 0,
                    skipped: 0,
                    errors: 1,
                    items: [],
                });
            }

            const rateCheck = await rateLimiter.consumeRateLimit(sourceType, `preview:${request.ip}`);
            if (!rateCheck.allowed) {
                return reply.status(429).send({
                    success: false,
                    message: 'rate limit exceeded for preview requests',
                    fetched: 0,
                    normalized: 0,
                    skipped: 0,
                    errors: 1,
                    items: [],
                });
            }

            const safeLimit = Math.max(1, Math.min(limit, 20));

            try {
                const result = await fetchFromSource({
                    id: `preview-${Date.now()}`,
                    type: sourceType,
                    name: name || url,
                    url,
                    enabled: true,
                    pollIntervalMs: 0,
                    settings: settings || {},
                });

                const sampleItems = result.items.slice(0, safeLimit);
                const normalization = normalizeBatch(sampleItems);
                const previewItems = normalization.normalized.map((item) => ({
                    idempotencyKey: item.idempotencyKey,
                    type: item.type,
                    title: item.title,
                    excerpt: item.excerpt,
                    author: item.author,
                    originalUrl: item.originalUrl,
                    publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
                }));

                return reply.send({
                    success: true,
                    message: 'Preview generated successfully',
                    fetched: result.items.length,
                    normalized: previewItems.length,
                    skipped: normalization.skipped,
                    errors: result.metadata.errors + normalization.errors.length,
                    items: previewItems,
                });
            } catch (error) {
                logger.error('Source preview failed', error, { sourceType, url });
                return reply.status(500).send({
                    success: false,
                    message: error instanceof Error ? error.message : 'Preview failed',
                    fetched: 0,
                    normalized: 0,
                    skipped: 0,
                    errors: 1,
                    items: [],
                });
            }
        }
    );

    /**
     * Trigger a manual poll for any source type
     * POST /admin/trigger
     */
    fastify.post<{ Body: TriggerBody; Reply: TriggerResponse }>(
        '/admin/trigger',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { sourceType, url, name, settings } = request.body;

            if (!sourceType || !url) {
                return reply.status(400).send({
                    success: false,
                    message: 'sourceType and url are required',
                });
            }

            try {
                const jobId = await scheduler.triggerPoll({
                    id: `manual-${Date.now()}`,
                    type: sourceType,
                    name: name || url,
                    url,
                    enabled: true,
                    pollIntervalMs: 0,
                    settings: settings || {},
                });

                logger.info('Admin triggered poll', { sourceType, url, jobId });

                return reply.send({
                    success: true,
                    jobId,
                    message: `Poll triggered for ${sourceType} source`,
                });
            } catch (error) {
                logger.error('Admin trigger failed', error);
                return reply.status(500).send({
                    success: false,
                    message: error instanceof Error ? error.message : 'Unknown error',
                });
            }
        }
    );

    /**
     * Trigger RSS poll (convenience endpoint)
     * POST /admin/trigger/rss
     */
    fastify.post<{ Body: { feedUrl: string; name?: string }; Reply: TriggerResponse }>(
        '/admin/trigger/rss',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { feedUrl, name } = request.body;

            if (!feedUrl) {
                return reply.status(400).send({
                    success: false,
                    message: 'feedUrl is required',
                });
            }

            const jobId = await scheduler.triggerPoll({
                id: `rss-${Date.now()}`,
                type: 'RSS',
                name: name || feedUrl,
                url: feedUrl,
                enabled: true,
                pollIntervalMs: 0,
                settings: {},
            });

            return reply.send({
                success: true,
                jobId,
                message: 'RSS poll triggered',
            });
        }
    );

    /**
     * Trigger YouTube poll
     * POST /admin/trigger/youtube
     */
    fastify.post<{
        Body: { channelId?: string; playlistId?: string; name?: string };
        Reply: TriggerResponse
    }>(
        '/admin/trigger/youtube',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { channelId, playlistId, name } = request.body;

            if (!channelId && !playlistId) {
                return reply.status(400).send({
                    success: false,
                    message: 'channelId or playlistId is required',
                });
            }

            const jobId = await scheduler.triggerPoll({
                id: `yt-${channelId || playlistId}-${Date.now()}`,
                type: 'YOUTUBE',
                name: name || channelId || playlistId || 'Unknown',
                url: channelId || playlistId || '',
                enabled: true,
                pollIntervalMs: 0,
                settings: { channelId, playlistId },
            });

            return reply.send({
                success: true,
                jobId,
                message: 'YouTube poll triggered',
            });
        }
    );

    /**
     * Trigger Reddit poll
     * POST /admin/trigger/reddit
     */
    fastify.post<{
        Body: { subreddit: string; sortBy?: string; minScore?: number };
        Reply: TriggerResponse
    }>(
        '/admin/trigger/reddit',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { subreddit, sortBy, minScore } = request.body;

            if (!subreddit) {
                return reply.status(400).send({
                    success: false,
                    message: 'subreddit is required',
                });
            }

            const jobId = await scheduler.triggerPoll({
                id: `reddit-${subreddit}-${Date.now()}`,
                type: 'REDDIT',
                name: `r/${subreddit}`,
                url: subreddit,
                enabled: true,
                pollIntervalMs: 0,
                settings: { subreddit, sortBy: sortBy || 'hot', minScore: minScore || 10 },
            });

            return reply.send({
                success: true,
                jobId,
                message: 'Reddit poll triggered',
            });
        }
    );

    /**
     * Get all queue statistics
     * GET /admin/queues
     */
    fastify.get<{ Reply: QueueStatsResponse[] }>(
        '/admin/queues',
        { preHandler: verifyAdminAuth },
        async (_request, reply) => {
            const stats: QueueStatsResponse[] = [];

            for (const queueName of Object.values(QUEUE_NAMES)) {
                const queue = getQueue(queueName);
                if (!queue) continue;

                const counts = await queue.getJobCounts();

                stats.push({
                    queue: queueName,
                    waiting: counts.waiting || 0,
                    active: counts.active || 0,
                    completed: counts.completed || 0,
                    failed: counts.failed || 0,
                    delayed: counts.delayed || 0,
                });
            }

            return reply.send(stats);
        }
    );

    /**
     * Get specific queue statistics
     * GET /admin/queues/:name/stats
     */
    fastify.get<{ Params: { name: string }; Reply: QueueStatsResponse | { error: string } }>(
        '/admin/queues/:name/stats',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { name } = request.params;
            const queue = getQueue(name as any);

            if (!queue) {
                return reply.status(404).send({ error: `Queue '${name}' not found` });
            }

            const counts = await queue.getJobCounts();

            return reply.send({
                queue: name,
                waiting: counts.waiting || 0,
                active: counts.active || 0,
                completed: counts.completed || 0,
                failed: counts.failed || 0,
                delayed: counts.delayed || 0,
            });
        }
    );

    /**
     * Get job by ID from any queue
     * GET /admin/jobs/:id
     */
    fastify.get<{ Params: { id: string }; Querystring: { queue?: string }; Reply: JobResponse | { error: string } }>(
        '/admin/jobs/:id',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { id } = request.params;
            const { queue: queueName } = request.query;

            // If queue specified, search that queue only
            const queuesToSearch = queueName
                ? [queueName]
                : Object.values(QUEUE_NAMES);

            for (const qName of queuesToSearch) {
                const queue = getQueue(qName as any);
                if (!queue) continue;

                const job = await queue.getJob(id);
                if (job) {
                    const state = await job.getState();
                    return reply.send({
                        id: job.id || id,
                        name: job.name,
                        data: job.data,
                        state,
                        progress: job.progress,
                        attemptsMade: job.attemptsMade,
                        failedReason: job.failedReason,
                        processedOn: job.processedOn,
                        finishedOn: job.finishedOn,
                        timestamp: job.timestamp,
                    });
                }
            }

            return reply.status(404).send({ error: `Job '${id}' not found` });
        }
    );

    /**
     * Get rate limit status
     * GET /admin/ratelimits/:sourceType
     */
    fastify.get<{ Params: { sourceType: string }; Querystring: { sourceId?: string } }>(
        '/admin/ratelimits/:sourceType',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { sourceType } = request.params;
            const { sourceId } = request.query;

            const status = await rateLimiter.getRateLimitStatus(sourceType, sourceId);
            return reply.send({
                sourceType,
                sourceId: sourceId || 'default',
                ...status,
            });
        }
    );

    /**
     * Get all rate limit configurations
     * GET /admin/ratelimits
     */
    fastify.get('/admin/ratelimits', { preHandler: verifyAdminAuth }, async (_request, reply) => {
        const limits = rateLimiter.getRateLimits();
        return reply.send(limits);
    });

    /**
     * Get scheduled jobs
     * GET /admin/scheduled
     */
    fastify.get('/admin/scheduled', { preHandler: verifyAdminAuth }, async (_request, reply) => {
        const jobs = await scheduler.getScheduledJobs();
        return reply.send(jobs);
    });

    /**
     * Search iTunes for podcasts
     * GET /admin/itunes/search
     */
    fastify.get<{ Querystring: { term: string; limit?: number; country?: string } }>(
        '/admin/itunes/search',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { term, limit, country } = request.query;

            if (!term) {
                return reply.status(400).send({ error: 'term query parameter is required' });
            }

            if (!itunesSearch.isEnabled()) {
                return reply.status(503).send({ error: 'iTunes Search is disabled' });
            }

            try {
                const result = await itunesSearch.searchPodcasts(term, limit || 25, country || 'US');
                return reply.send(result);
            } catch (error) {
                logger.error('iTunes search endpoint error', error);
                return reply.status(500).send({ error: 'iTunes search failed' });
            }
        }
    );
}
