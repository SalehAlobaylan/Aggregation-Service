/**
 * Admin routes for manual triggers and inspection
 */
import { FastifyInstance } from 'fastify';
import { scheduler } from '../../services/scheduler.service.js';
import { getQueue, QUEUE_NAMES } from '../../queues/index.js';
import { logger } from '../../observability/logger.js';
import type { SourceType } from '../../queues/schemas.js';

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

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
    /**
     * Trigger a manual poll for any source type
     * POST /admin/trigger
     */
    fastify.post<{ Body: TriggerBody; Reply: TriggerResponse }>(
        '/admin/trigger',
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
     * Get queue statistics
     * GET /admin/queues
     */
    fastify.get<{ Reply: QueueStatsResponse[] }>(
        '/admin/queues',
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
     * Get scheduled jobs
     * GET /admin/scheduled
     */
    fastify.get('/admin/scheduled', async (_request, reply) => {
        const jobs = await scheduler.getScheduledJobs();
        return reply.send(jobs);
    });
}
