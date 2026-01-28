/**
 * Health endpoint - liveness check
 * GET /health
 */
import { FastifyInstance } from 'fastify';

interface HealthResponse {
    status: 'healthy' | 'unhealthy';
    timestamp: string;
}

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.get<{ Reply: HealthResponse }>('/health', async (_request, reply) => {
        return reply.send({
            status: 'healthy',
            timestamp: new Date().toISOString(),
        });
    });
}
