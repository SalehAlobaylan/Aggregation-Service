/**
 * Metrics endpoint - Prometheus format
 * GET /metrics
 */
import { FastifyInstance } from 'fastify';
import { getMetrics, getContentType } from '../../observability/metrics.js';
import { updateQueueMetrics } from '../../queues/index.js';

export async function metricsRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.get('/metrics', async (_request, reply) => {
        // Update queue depth metrics before returning
        await updateQueueMetrics();

        const metrics = await getMetrics();

        return reply
            .header('Content-Type', getContentType())
            .send(metrics);
    });
}
