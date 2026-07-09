/**
 * Admin routes for manual triggers and inspection
 */
import { FastifyInstance } from 'fastify';
import { scheduler } from '../../services/scheduler.service.js';
import { getQueue, QUEUE_NAMES } from '../../queues/index.js';
import { enqueueRetryJob } from '../../queues/retry-routing.js';
import { rateLimiter } from '../../services/rate-limiter.js';
import { itunesSearch } from '../../services/itunes-search.js';
import { logger } from '../../observability/logger.js';
import type { SourceType, ContentType, DiscoveryJob, DiscoveryProfileInput, DiscoverySweepJob, SourceGraphJob, NewsCirculationJob, AtomizationSweepJob, AtomizationJob, AIJob } from '../../queues/schemas.js';
import { verifyAdminAuth } from '../plugins/admin-auth.js';
import { feedDiscoveryService } from '../../services/feed-discovery.service.js';
import { fetchFromSource, getSupportedSourceTypes } from '../../fetchers/index.js';
import { resolveYoutubeChannel } from '../../fetchers/youtube.fetcher.js';
import { normalizeBatch } from '../../normalizers/index.js';
import { cmsClient } from '../../cms/client.js';
import {
    getAllWorkers,
    syncDiscoverySweeper,
    syncNewsCirculationSweeper,
    syncRepeatableSweepers,
    syncSourceGraphSweeper,
} from '../../workers/index.js';
import { importYouTubeFeed, importYouTubeLinks } from '../../services/discovery/youtube-import.js';
// quality-sweeper worker removed in Phase 7; re-encoding is now driven by
// the storage sweeper (when archive_action='re_encode').
import { probeContentItem } from '../../services/quality.service.js';
import type { QualityReencodeJob } from '../../queues/schemas.js';
import {
    computeStorageUsage,
    deleteContentObjects,
    deleteObjectsByKeys,
    isColdTierConfigured,
} from '../../storage/client.js';
import { runSweepForTenant, reconcileStorage } from '../../services/storage.service.js';
import type { StorageSweepJob } from '../../queues/schemas.js';

interface TriggerBody {
    sourceType: SourceType;
    url: string;
    name?: string;
    settings?: Record<string, unknown>;
    /** The CMS source public UUID. When present, the run uses it as sourceId so
     *  fetch/normalize telemetry reports back to source_run_telemetry. */
    sourceId?: string;
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

interface RetryFailedBody {
    source?: string;
    ids?: string[];
    limit?: number;
}

interface RetryFailedResponse {
    success: boolean;
    message: string;
    requeued: number;
    total: number;
    errors: string[];
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
                    // Rich media metadata for the "Add media source" preview.
                    thumbnailUrl: item.thumbnailUrl ?? null,
                    durationSec: item.durationSec ?? null,
                }));

                return reply.send({
                    success: true,
                    // Surface the fetcher's failure reason (e.g. X 429) when nothing came back.
                    message: result.items.length === 0 && result.metadata.reason
                        ? result.metadata.reason
                        : 'Preview generated successfully',
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
            const { sourceType, url, name, settings, sourceId } = request.body;

            if (!sourceType || !url) {
                return reply.status(400).send({
                    success: false,
                    message: 'sourceType and url are required',
                });
            }

            const isUuid = typeof sourceId === 'string'
                && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceId);

            try {
                const jobId = await scheduler.triggerPoll({
                    id: isUuid ? sourceId : `manual-${Date.now()}`,
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
     * Re-sync the scheduled discovery sweep from CMS config (proxied by CMS when
     * an admin saves discovery config). POST /admin/discovery/resync-schedule
     */
    fastify.post(
        '/admin/discovery/resync-schedule',
        { preHandler: verifyAdminAuth },
        async (_request, reply) => {
            try {
                await Promise.all([syncDiscoverySweeper(), syncSourceGraphSweeper()]);
                return reply.send({ success: true, message: 'Discovery + graph schedules re-synced' });
            } catch (error) {
                logger.error('Discovery schedule resync failed', error);
                return reply.status(500).send({ success: false, message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    );

    /**
     * Re-sync the scheduled News Circulation source-claim worker from CMS policy.
     * POST /admin/circulation/resync-schedule
     */
    fastify.post('/admin/circulation/resync-schedule', { preHandler: verifyAdminAuth }, async (_request, reply) => {
        try {
            await syncNewsCirculationSweeper();
            return reply.send({ success: true, message: 'News circulation schedule re-synced' });
        } catch (error) {
            logger.error('News circulation schedule resync failed', error);
            return reply.status(500).send({ success: false, message: error instanceof Error ? error.message : 'Unknown error' });
        }
    });

    /**
     * Manually claim due news sources now. POST /admin/circulation/sweep-now
     */
    fastify.post('/admin/circulation/sweep-now', { preHandler: verifyAdminAuth }, async (_request, reply) => {
        const q = getQueue(QUEUE_NAMES.NEWS_CIRCULATION);
        if (!q) return reply.status(503).send({ success: false, message: 'news circulation queue unavailable' });
        const job = await q.add('manual-news-circulation', { trigger: 'manual', tenantId: 'default' } satisfies NewsCirculationJob, { priority: 1 });
        return reply.send({ success: true, jobId: job.id ?? undefined, message: 'News circulation source claim queued' });
    });

    /**
     * Manually sweep all enabled interests now (proxied from CMS). Runs even when
     * scheduled automation is off (trigger: 'manual'). POST /admin/discovery/sweep-now
     */
    fastify.post('/admin/discovery/sweep-now', { preHandler: verifyAdminAuth }, async (_request, reply) => {
        const q = getQueue(QUEUE_NAMES.DISCOVERY_SWEEP);
        if (!q) return reply.status(503).send({ success: false, message: 'discovery sweep queue unavailable' });
        const job = await q.add('manual-sweep', { trigger: 'manual' } satisfies DiscoverySweepJob);
        return reply.send({ success: true, jobId: job.id ?? undefined, message: 'Discovery sweep queued' });
    });

    /**
     * Manually rebuild the source-intelligence graph now (proxied from CMS).
     * POST /admin/discovery/build-graph-now
     */
    fastify.post('/admin/discovery/build-graph-now', { preHandler: verifyAdminAuth }, async (_request, reply) => {
        const q = getQueue(QUEUE_NAMES.SOURCE_GRAPH);
        if (!q) return reply.status(503).send({ success: false, message: 'source graph queue unavailable' });
        const job = await q.add('manual-graph', { trigger: 'manual' } satisfies SourceGraphJob);
        return reply.send({ success: true, jobId: job.id ?? undefined, message: 'Source graph build queued' });
    });

    /**
     * Manually enqueue transcript-ready media parents for atomization.
     * POST /admin/atomization/sweep-now
     */
    fastify.post('/admin/atomization/sweep-now', { preHandler: verifyAdminAuth }, async (_request, reply) => {
        const q = getQueue(QUEUE_NAMES.ATOMIZATION_SWEEP);
        if (!q) return reply.status(503).send({ success: false, message: 'atomization sweep queue unavailable' });
        const job = await q.add('manual-atomization-sweep', { trigger: 'manual', tenantId: 'default' } satisfies AtomizationSweepJob, { priority: 1 });
        return reply.send({ success: true, jobId: job.id ?? undefined, message: 'Atomization candidate sweep queued' });
    });

    fastify.post<{
        Params: { id: string };
        Body: {
            contentItemId?: string;
            reason?: 'manual' | 'reatomize';
            hasTranscript?: boolean;
            contentType?: string;
            mediaUrl?: string;
            thumbnailUrl?: string;
            title?: string | null;
            excerpt?: string | null;
            bodyText?: string | null;
        };
    }>('/admin/atomization/parents/:id/atomize', { preHandler: verifyAdminAuth }, async (request, reply) => {
        const contentItemId = request.body?.contentItemId || request.params.id;
        const reason = request.body?.reason === 'reatomize' ? 'reatomize' : 'manual';
        if (!contentItemId) {
            return reply.status(400).send({ success: false, message: 'contentItemId is required' });
        }

        if (!request.body?.hasTranscript) {
            const aiQueue = getQueue(QUEUE_NAMES.AI);
            if (!aiQueue) return reply.status(503).send({ success: false, message: 'AI queue unavailable for transcript request' });
            if (!request.body?.mediaUrl) return reply.status(400).send({ success: false, message: 'mediaUrl is required when transcript is missing' });
            const jobId = `atomization-transcript-${contentItemId}`;
            const existing = await aiQueue.getJob(jobId);
            if (existing) {
                const state = await existing.getState();
                if (state === 'failed' || state === 'completed') {
                    await existing.remove();
                } else {
                    return reply.send({ success: true, jobId, message: 'Transcript request already queued' });
                }
            }
            await aiQueue.add(
                `atomization-transcript-${contentItemId}`,
                {
                    contentItemId,
                    contentType: (request.body.contentType || 'PODCAST') as ContentType,
                    operations: ['transcript'],
                    textContent: {
                        title: request.body.title ?? '',
                        excerpt: request.body.excerpt ?? undefined,
                        bodyText: request.body.bodyText ?? undefined,
                    },
                    mediaUrl: request.body.mediaUrl,
                    heroImageUrl: request.body.thumbnailUrl ?? undefined,
                    forceStt: true,
                } satisfies AIJob,
                { priority: 1, jobId, removeOnComplete: { age: 3600, count: 200 }, removeOnFail: { age: 86400 } }
            );
            return reply.send({ success: true, jobId, message: 'Transcript request queued before atomization' });
        }

        const atomizationQueue = getQueue(QUEUE_NAMES.ATOMIZATION);
        if (!atomizationQueue) return reply.status(503).send({ success: false, message: 'atomization queue unavailable' });
        const jobId = `${reason === 'reatomize' ? 'reatomize' : 'atomize'}-${contentItemId}`;
        const existing = await atomizationQueue.getJob(jobId);
        if (existing) {
            const state = await existing.getState();
            if (state === 'failed' || state === 'completed') {
                await existing.remove();
            } else {
                return reply.send({ success: true, jobId, message: 'Atomization already queued' });
            }
        }
        const job = await atomizationQueue.add(
            jobId,
            { contentItemId, reason } satisfies AtomizationJob,
            { priority: 1, jobId, removeOnComplete: { age: 3600, count: 200 }, removeOnFail: { age: 86400 } }
        );
        return reply.send({ success: true, jobId: job.id ?? jobId, message: reason === 'reatomize' ? 'Re-atomization queued' : 'Atomization queued' });
    });

    /**
     * Trigger a one-off source-discovery sweep for a profile (proxied from CMS).
     * POST /admin/discovery/run
     */
    fastify.post<{ Body: { profile?: DiscoveryProfileInput }; Reply: TriggerResponse }>(
        '/admin/discovery/run',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const profile = request.body?.profile;
            if (!profile || !profile.id || !profile.name) {
                return reply.status(400).send({ success: false, message: 'profile.id and profile.name are required' });
            }
            try {
                const queue = getQueue(QUEUE_NAMES.DISCOVERY);
                if (!queue) {
                    return reply.status(503).send({ success: false, message: 'discovery queue unavailable' });
                }
                const job = await queue.add(
                    `discovery-${profile.id}-${Date.now()}`,
                    { profile, triggeredBy: 'manual' } satisfies DiscoveryJob,
                    { priority: 2 }
                );
                logger.info('Admin triggered discovery sweep', { profile: profile.name, jobId: job.id });
                return reply.send({ success: true, jobId: job.id ?? undefined, message: `Discovery queued for ${profile.name}` });
            } catch (error) {
                logger.error('Admin discovery trigger failed', error);
                return reply.status(500).send({ success: false, message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    );

    /**
     * Import channels from a pasted youtubei/v1 payload (the manual seed path).
     * POST /admin/discovery/import-youtube
     *
     * Synchronous: parses the blob, enriches each channel via guest InnerTube,
     * and posts them as suggestions for review. bodyLimit is raised because a
     * personalized home-feed dump easily exceeds Fastify's 1 MB default.
     */
    fastify.post<{
        Body: { raw?: unknown; profileId?: string; tenantId?: string; keywords?: string[] };
    }>(
        '/admin/discovery/import-youtube',
        { preHandler: verifyAdminAuth, bodyLimit: 16 * 1024 * 1024 },
        async (request, reply) => {
            const { raw, profileId, tenantId, keywords } = request.body ?? {};
            if (!raw || typeof raw !== 'object') {
                return reply.status(400).send({ success: false, message: 'raw youtubei/v1 payload (object) is required' });
            }
            try {
                const result = await importYouTubeFeed({ raw, profileId, tenantId, keywords });
                logger.info('Admin imported YouTube feed', { profileId, ...result });
                return reply.send({ success: true, ...result });
            } catch (error) {
                logger.error('YouTube import failed', error);
                return reply.status(500).send({ success: false, message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    );

    /**
     * Import channels from pasted YouTube links/@handles (the low-friction seed
     * path). POST /admin/discovery/import-youtube-links
     *
     * Synchronous: resolves each reference to its channel via guest InnerTube,
     * enriches it, and posts suggestions for review — same path as the JSON paste,
     * minus the 1 MB DevTools blob.
     */
    fastify.post<{
        Body: { inputs?: string[]; profileId?: string; tenantId?: string; keywords?: string[] };
    }>(
        '/admin/discovery/import-youtube-links',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { inputs, profileId, tenantId, keywords } = request.body ?? {};
            if (!Array.isArray(inputs) || inputs.length === 0) {
                return reply.status(400).send({ success: false, message: 'inputs (array of YouTube links/@handles) is required' });
            }
            try {
                const result = await importYouTubeLinks({ inputs, profileId, tenantId, keywords });
                logger.info('Admin imported YouTube links', { profileId, ...result });
                return reply.send({ success: true, ...result });
            } catch (error) {
                logger.error('YouTube link import failed', error);
                return reply.status(500).send({ success: false, message: error instanceof Error ? error.message : 'Unknown error' });
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
     * Self-restart
     * POST /admin/restart
     *
     * Replies 202 then sends SIGTERM to the process so the existing
     * graceful-shutdown handler in src/index.ts runs (closes workers,
     * queues, Redis). The process must be supervised (Cranl, k8s, systemd,
     * Docker restart:always) for it to actually come back.
     */
    fastify.post(
        '/admin/restart',
        { preHandler: verifyAdminAuth },
        async (_request, reply) => {
            logger.info('Restart requested via /admin/restart');
            reply.code(202).send({
                message:
                    'Restart accepted. Service is shutting down — supervisor must bring it back.',
                service: 'aggregation',
            });

            setTimeout(() => {
                process.kill(process.pid, 'SIGTERM');
            }, 250);
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
     * Purge all jobs from a queue or all queues
     * POST /admin/queues/purge
     *
     * This removes ALL jobs: waiting, delayed, failed, completed AND active.
     * Workers are paused during the purge so in-progress jobs are killed.
     */
    fastify.post<{ Body: { queue?: string; states?: string[]; includeFailed?: boolean } }>(
        '/admin/queues/purge',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { queue: queueName, states, includeFailed = true } = request.body || {};
            const purged: Record<string, number> = {};

            // If states array is provided, use it; otherwise fall back to legacy includeFailed behavior
            const allStates = ['waiting', 'delayed', 'active', 'completed', 'failed'];
            const statesToPurge = states && states.length > 0
                ? states.filter(s => allStates.includes(s))
                : [...(includeFailed ? allStates : allStates.filter(s => s !== 'failed'))];

            const needsPause = statesToPurge.includes('active');

            const queuesToPurge = queueName
                ? [queueName]
                : Object.values(QUEUE_NAMES);

            let pausedWorkers: ReturnType<typeof getAllWorkers> = [];

            // Pause workers only if we're killing active jobs
            if (needsPause) {
                pausedWorkers = getAllWorkers();
                for (const worker of pausedWorkers) {
                    try { await worker.pause(); } catch (_) { /* already paused */ }
                }
            }

            try {
                for (const qName of queuesToPurge) {
                    const queue = getQueue(qName as any);
                    if (!queue) continue;

                    let removedCount = 0;

                    if (statesToPurge.includes('failed')) {
                        const r = await queue.clean(0, 0, 'failed');
                        removedCount += r.length;
                    }
                    if (statesToPurge.includes('completed')) {
                        const r = await queue.clean(0, 0, 'completed');
                        removedCount += r.length;
                    }
                    if (statesToPurge.includes('waiting')) {
                        const r = await queue.clean(0, 0, 'wait');
                        removedCount += r.length;
                        await queue.drain();
                    }
                    if (statesToPurge.includes('delayed')) {
                        const r = await queue.clean(0, 0, 'delayed');
                        removedCount += r.length;
                    }
                    if (statesToPurge.includes('active')) {
                        const activeJobs = await queue.getActive();
                        for (const job of activeJobs) {
                            try {
                                await job.moveToFailed(new Error('Purged by admin'), '0', true);
                                await job.remove();
                                removedCount++;
                            } catch (_) { /* job may have finished */ }
                        }
                    }

                    purged[qName] = removedCount;
                    logger.info('Queue purged', { queue: qName, states: statesToPurge, removedCount });
                }

                return reply.send({
                    success: true,
                    message: `Purged ${Object.keys(purged).length} queue(s) — states: ${statesToPurge.join(', ')}`,
                    purged,
                });
            } finally {
                if (needsPause) {
                    await Promise.allSettled(pausedWorkers.map(worker => worker.resume()));
                }
            }
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

    /**
     * Resolve a YouTube channel URL/@handle to channel metadata (name + avatar)
     * GET /admin/youtube/resolve?url=...
     */
    fastify.get<{ Querystring: { url: string } }>(
        '/admin/youtube/resolve',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { url } = request.query;
            if (!url) {
                return reply.status(400).send({ error: 'url query parameter is required' });
            }
            try {
                const channel = await resolveYoutubeChannel(url);
                if (!channel) {
                    return reply.status(404).send({ error: 'Could not resolve a YouTube channel from that URL' });
                }
                return reply.send(channel);
            } catch (error) {
                logger.error('YouTube resolve endpoint error', error);
                return reply.status(500).send({ error: 'YouTube resolve failed' });
            }
        }
    );

    /**
     * Requeue FAILED content items back into the media pipeline
     * POST /admin/retry-failed
     * Body: { ids?: string[], source?: "TELEGRAM"|"YOUTUBE"|..., limit?: number }
     *
     * - Fetches FAILED items from CMS (filtered by source if provided)
     * - Resets each item's status to PENDING
     * - Enqueues a fresh media job for each item
     * Returns the count of successfully requeued items.
     */
    fastify.post<{ Body: RetryFailedBody; Reply: RetryFailedResponse }>(
        '/admin/retry-failed',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { source, ids, limit = 100 } = request.body ?? {};
            const safeLimit = Math.max(1, Math.min(limit, 500));

            const mediaQueue = getQueue(QUEUE_NAMES.MEDIA);
            if (!mediaQueue) {
                return reply.status(503).send({
                    success: false,
                    message: 'Media queue is not available',
                    requeued: 0,
                    total: 0,
                    errors: [],
                });
            }

            let listResult;
            try {
                listResult = await cmsClient.listContentItems({
                    status: 'FAILED',
                    source: ids?.length ? undefined : source?.toUpperCase(),
                    ids,
                    limit: safeLimit,
                });
            } catch (err) {
                logger.error('retry-failed: failed to list content items from CMS', err);
                return reply.status(502).send({
                    success: false,
                    message: `Failed to fetch FAILED items from CMS: ${err instanceof Error ? err.message : String(err)}`,
                    requeued: 0,
                    total: 0,
                    errors: [],
                });
            }

            let requeued = 0;
            const errors: string[] = [];

            const aiQueue = getQueue(QUEUE_NAMES.AI);

            for (const item of listResult.data) {
                try {
                    // Reset status so the item can progress again
                    await cmsClient.updateStatus(item.id, { status: 'PENDING' });

                    // Routes Telegram text posts to embedding instead of the media queue.
                    await enqueueRetryJob(
                        { media: mediaQueue, ai: aiQueue },
                        item,
                        { namePrefix: 'retry-media', priority: 3 },
                    );

                    requeued++;
                    logger.info('retry-failed: requeued item', { contentItemId: item.id, source: item.source });
                } catch (err) {
                    const msg = `${item.id}: ${err instanceof Error ? err.message : String(err)}`;
                    errors.push(msg);
                    logger.warn('retry-failed: failed to requeue item', { contentItemId: item.id, error: msg });
                }
            }

            return reply.send({
                success: true,
                message: `Re-queued ${requeued} of ${listResult.data.length} FAILED items`,
                requeued,
                total: listResult.total,
                errors,
            });
        }
    );

    /**
     * Enqueue media jobs for PENDING content items that were never processed.
     * POST /admin/retry-pending
     * Body: { ids?: string[], source?: "TELEGRAM"|"YOUTUBE"|..., limit?: number }
     *
     * Unlike retry-failed (which resets FAILED→PENDING), this targets items
     * already in PENDING status whose media jobs were never enqueued or got lost.
     */
    fastify.post<{ Body: RetryFailedBody; Reply: RetryFailedResponse }>(
        '/admin/retry-pending',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { source, ids, limit = 200 } = request.body ?? {};
            const safeLimit = Math.max(1, Math.min(limit, 500));

            const mediaQueue = getQueue(QUEUE_NAMES.MEDIA);
            if (!mediaQueue) {
                return reply.status(503).send({
                    success: false,
                    message: 'Media queue is not available',
                    requeued: 0,
                    total: 0,
                    errors: [],
                });
            }

            let listResult;
            try {
                listResult = await cmsClient.listContentItems({
                    status: 'PENDING',
                    source: ids?.length ? undefined : source?.toUpperCase(),
                    ids,
                    limit: safeLimit,
                });
            } catch (err) {
                logger.error('retry-pending: failed to list content items from CMS', err);
                return reply.status(502).send({
                    success: false,
                    message: `Failed to fetch PENDING items from CMS: ${err instanceof Error ? err.message : String(err)}`,
                    requeued: 0,
                    total: 0,
                    errors: [],
                });
            }

            const aiQueue = getQueue(QUEUE_NAMES.AI);

            let requeued = 0;
            const errors: string[] = [];

            for (const item of listResult.data) {
                try {
                    // Routes Telegram text posts to embedding instead of the media queue.
                    await enqueueRetryJob(
                        { media: mediaQueue, ai: aiQueue },
                        item,
                        { namePrefix: 'retry-pending', priority: 5 },
                    );

                    requeued++;
                    logger.info('retry-pending: enqueued item', { contentItemId: item.id, source: item.source });
                } catch (err) {
                    const msg = `${item.id}: ${err instanceof Error ? err.message : String(err)}`;
                    errors.push(msg);
                    logger.warn('retry-pending: failed to enqueue item', { contentItemId: item.id, error: msg });
                }
            }

            return reply.send({
                success: true,
                message: `Enqueued ${requeued} of ${listResult.data.length} PENDING items for media processing`,
                requeued,
                total: listResult.total,
                errors,
            });
        }
    );

    // -----------------------------------------------------------------
    // Storage management
    // -----------------------------------------------------------------

    /**
     * GET /admin/storage/stats
     * Live bucket usage for primary (and cold, if configured), grouped by
     * artifact type. Cached briefly to avoid hammering S3.
     */
    interface StatsPayload {
        used_bytes: number;
        object_count: number;
        by_artifact_type: Record<string, number>;
        cold_enabled: boolean;
        cold?: {
            used_bytes: number;
            object_count: number;
            by_artifact_type: Record<string, number>;
        };
    }
    let cachedStats: { at: number; data: StatsPayload } | null = null;
    let statsInFlight: Promise<StatsPayload> | null = null;
    const STORAGE_STATS_TTL_MS = 60 * 1000;

    async function loadStorageStatsPayload(): Promise<StatsPayload> {
        const primary = await computeStorageUsage('primary');
        const payload: StatsPayload = {
            used_bytes: primary.usedBytes,
            object_count: primary.objectCount,
            by_artifact_type: primary.byArtifactType,
            cold_enabled: isColdTierConfigured(),
        };
        if (payload.cold_enabled) {
            try {
                const cold = await computeStorageUsage('cold');
                payload.cold = {
                    used_bytes: cold.usedBytes,
                    object_count: cold.objectCount,
                    by_artifact_type: cold.byArtifactType,
                };
            } catch (coldErr) {
                logger.warn('storage.stats: cold tier query failed', { error: (coldErr as Error).message });
            }
        }
        cachedStats = { at: Date.now(), data: payload };
        return payload;
    }

    fastify.get(
        '/admin/storage/stats',
        { preHandler: verifyAdminAuth },
        async (_request, reply) => {
            if (cachedStats && Date.now() - cachedStats.at < STORAGE_STATS_TTL_MS) {
                return reply.send(cachedStats.data);
            }
            try {
                if (!statsInFlight) {
                    statsInFlight = loadStorageStatsPayload().finally(() => {
                        statsInFlight = null;
                    });
                }
                const payload = await statsInFlight;
                return reply.send(payload);
            } catch (err) {
                logger.error('storage.stats: failed', err);
                return reply.status(502).send({
                    error: err instanceof Error ? err.message : 'storage stats failed',
                });
            }
        }
    );

    interface DeleteObjectsBody {
        keys?: string[];
        content_ids?: string[];
        artifacts?: string[];
        tier?: 'primary' | 'cold';
    }

    /**
     * POST /admin/storage/delete-objects
     * Either delete a list of explicit S3 keys, or all artifacts for a list of content IDs.
     * Defaults to primary tier; pass `tier: 'cold'` to delete from cold storage.
     */
    fastify.post<{ Body: DeleteObjectsBody }>(
        '/admin/storage/delete-objects',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { keys, content_ids: contentIds, artifacts, tier = 'primary' } = request.body ?? {};
            try {
                let deletedCount = 0;
                let freedBytes = 0;
                const errors: string[] = [];

                if (keys && keys.length > 0) {
                    const out = await deleteObjectsByKeys(keys, tier);
                    deletedCount += out.deletedCount;
                    freedBytes += out.freedBytes;
                    errors.push(...out.errors);
                }
                if (contentIds && contentIds.length > 0) {
                    for (const id of contentIds) {
                        const out = await deleteContentObjects(id, artifacts, tier);
                        deletedCount += out.deletedCount;
                        freedBytes += out.freedBytes;
                        errors.push(...out.errors);
                    }
                }
                cachedStats = null;
                return reply.send({ deleted_count: deletedCount, freed_bytes: freedBytes, errors });
            } catch (err) {
                logger.error('storage.delete-objects: failed', err);
                return reply.status(500).send({ error: err instanceof Error ? err.message : 'delete failed' });
            }
        }
    );

    interface SweepBody {
        tenant_id?: string;
        trigger?: 'auto' | 'manual';
        candidate_ids?: string[];
        max_bytes?: number;
        limit?: number;
        archive_action?: 'move_to_cold' | 're_encode' | string;
    }

    /**
     * POST /admin/storage/sweep
     * Run one sweep cycle inline (no BullMQ) for the given tenant. Used by the
     * "Run sweep now" button in Platform-Console.
     */
    fastify.post<{ Body: SweepBody }>(
        '/admin/storage/sweep',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const tenantId = (request.body?.tenant_id ?? 'default').trim();
            const trigger = request.body?.trigger === 'auto' ? 'auto' : 'manual';

            try {
                const policies = await cmsClient.listStoragePolicies();
                const policy =
                    policies.all.find(p => p.tenant_id === tenantId) ??
                    policies.global ??
                    null;
                if (!policy) {
                    return reply.status(404).send({ error: 'No policy found' });
                }
                const effective = { ...policy, tenant_id: tenantId };
                const archiveAction =
                    request.body?.archive_action === 'move_to_cold' || request.body?.archive_action === 're_encode'
                        ? request.body.archive_action
                        : undefined;
                const candidateIds = Array.isArray(request.body?.candidate_ids)
                    ? request.body.candidate_ids.map(id => id.trim()).filter(Boolean)
                    : undefined;
                const result = await runSweepForTenant(effective, trigger, {
                    archiveAction,
                    candidateIds,
                    maxBytes: request.body?.max_bytes,
                    limit: request.body?.limit,
                });
                cachedStats = null;
                return reply.send({
                    success: true,
                    deleted_count: result.deletedCount,
                    moved_to_cold_count: result.movedToColdCount,
                    re_encoded_count: result.reEncodedCount,
                    freed_bytes: result.freedBytes,
                    skipped: result.skipped,
                    reason: result.reason,
                    error: result.error,
                });
            } catch (err) {
                logger.error('storage.sweep: failed', err);
                return reply.status(500).send({ error: err instanceof Error ? err.message : 'sweep failed' });
            }
        }
    );

    /**
     * POST /admin/storage/policy-changed
     * Tells Aggregation to re-register repeatable BullMQ sweepers based on the
     * current set of CMS policies. Called by CMS after a PUT to the policy.
     */
    fastify.post(
        '/admin/storage/policy-changed',
        { preHandler: verifyAdminAuth },
        async (_request, reply) => {
            try {
                await syncRepeatableSweepers();
                return reply.send({ success: true });
            } catch (err) {
                logger.error('storage.policy-changed: failed', err);
                return reply.status(500).send({ error: err instanceof Error ? err.message : 'sync failed' });
            }
        }
    );

    /**
     * GET /admin/storage/reconcile
     * Walks S3 + CMS to find orphan objects and missing artifacts.
     */
    fastify.get(
        '/admin/storage/reconcile',
        { preHandler: verifyAdminAuth },
        async (_request, reply) => {
            try {
                const out = await reconcileStorage();
                return reply.send({
                    orphan_keys: out.orphanKeys,
                    missing_objects: out.missingObjects,
                    orphan_count: out.orphanCount,
                    missing_count: out.missingCount,
                    scanned_object_count: out.scannedObjectCount,
                    scanned_cms_item_count: out.scannedCmsItemCount,
                    partial: out.partial,
                    truncated_reason: out.truncatedReason,
                });
            } catch (err) {
                logger.error('storage.reconcile: failed', err);
                return reply.status(500).send({ error: err instanceof Error ? err.message : 'reconcile failed' });
            }
        }
    );

    // Make TypeScript happy about the unused enqueue helper (kept for future
    // policy-changed-driven enqueue path).
    void (async () => {
        const _: StorageSweepJob = { tenantId: '', trigger: 'auto' };
        return _;
    });

    // -------------------------------------------------------------------------
    // Quality Management endpoints
    // -------------------------------------------------------------------------

    interface ProbeBody {
        content_item_id: string;
        tier?: 'primary' | 'cold';
    }

    /**
     * POST /admin/quality/probe
     * Live ffprobe of a content item's primary media artifact. Returns the
     * raw container info (duration, dims, bitrate, codecs) so the Console can
     * compute projected savings against arbitrary profiles client-side.
     */
    fastify.post<{ Body: ProbeBody }>(
        '/admin/quality/probe',
        { preHandler: verifyAdminAuth },
        async (request, reply) => {
            const { content_item_id, tier } = request.body ?? ({} as ProbeBody);
            if (!content_item_id) {
                return reply.status(400).send({ error: 'content_item_id is required' });
            }
            try {
                const out = await probeContentItem(content_item_id, tier ?? 'primary');
                return reply.send(out);
            } catch (err) {
                logger.error('quality.probe: failed', err, { content_item_id });
                return reply.status(500).send({
                    error: err instanceof Error ? err.message : 'probe failed',
                });
            }
        }
    );

    // POST /admin/quality/re-encode removed in Phase 7 — re-encoding is
    // orchestrated entirely from inside Aggregation by the storage sweep
    // worker (when archive_action='re_encode'). The CMS no longer calls a
    // re-encode HTTP endpoint; storage.service enqueues onto QUALITY_REENCODE
    // directly via getQueue(). Manual one-shot re-encodes are surfaced through
    // the storage "Run sweep now" button instead.

    /**
     * GET /admin/quality/queue-depth
     * Live queue stats for the in-flight badge in Console.
     */
    fastify.get(
        '/admin/quality/queue-depth',
        { preHandler: verifyAdminAuth },
        async (_request, reply) => {
            const queue = getQueue(QUEUE_NAMES.QUALITY_REENCODE);
            if (!queue) {
                return reply.send({ active: 0, waiting: 0, delayed: 0, failed: 0 });
            }
            const [active, waiting, delayed, failed] = await Promise.all([
                queue.getActiveCount(),
                queue.getWaitingCount(),
                queue.getDelayedCount(),
                queue.getFailedCount(),
            ]);
            return reply.send({ active, waiting, delayed, failed });
        }
    );
}
