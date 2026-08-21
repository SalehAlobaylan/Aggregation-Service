import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config/index.js';
import process from 'node:process';

/**
 * verifyInternalServiceAuth gates service-to-service internal routes with a
 * shared bearer token. CMS (and any other internal caller) must send
 * `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`. The comparison is
 * constant-time to avoid leaking the token through timing differences.
 */
export async function verifyInternalServiceAuth(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    // If the operator never set INTERNAL_SERVICE_TOKEN, refuse the call
    // outright — accepting any/empty token would defeat the whole point of
    // having an internal auth boundary. This keeps the service bootable
    // in dev while still failing loudly when the route is actually used.
    const migrationCapability = request.url.startsWith('/internal/database-migration');
    const expectedToken = migrationCapability
        ? process.env.DATABASE_MIGRATION_COORDINATOR_SERVICE_TOKEN?.trim()
        : config.internalServiceToken;
    if (!expectedToken) {
        await reply.status(503).send({
            message:
                migrationCapability
                    ? 'Database migration routes are disabled: configure the dedicated coordinator token'
                    : 'Internal service routes are disabled: set INTERNAL_SERVICE_TOKEN to enable',
        });
        return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        await reply.status(401).send({ message: 'Authentication required' });
        return;
    }

    const presented = Buffer.from(authHeader.slice(7).trim());
    const expected = Buffer.from(expectedToken);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        await reply.status(401).send({ message: 'Invalid service token' });
        return;
    }
}
