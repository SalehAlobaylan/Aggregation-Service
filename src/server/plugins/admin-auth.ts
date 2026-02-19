import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config/index.js';

interface JwtPayload {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    role?: string;
    [key: string]: unknown;
}

function parseJwtPayload(token: string): JwtPayload {
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('Malformed token');
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') {
        throw new Error('Invalid token algorithm');
    }

    const expectedSignature = createHmac('sha256', config.jwtSecret)
        .update(`${headerB64}.${payloadB64}`)
        .digest('base64url');

    const signature = Buffer.from(signatureB64);
    const expected = Buffer.from(expectedSignature);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
        throw new Error('Invalid token signature');
    }

    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as JwtPayload;
}

function hasExpectedAudience(aud: string | string[] | undefined, expected: string): boolean {
    if (Array.isArray(aud)) {
        return aud.includes(expected);
    }
    return aud === expected;
}

function isExpired(exp: number | undefined): boolean {
    if (typeof exp !== 'number') {
        return true;
    }
    return exp <= Math.floor(Date.now() / 1000);
}

export async function verifyAdminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        await reply.status(401).send({ message: 'Authentication required' });
        return;
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
        await reply.status(401).send({ message: 'Invalid authentication token' });
        return;
    }

    let payload: JwtPayload;
    try {
        payload = parseJwtPayload(token);
    } catch {
        await reply.status(401).send({ message: 'Invalid authentication token' });
        return;
    }

    if (isExpired(payload.exp)) {
        await reply.status(401).send({ message: 'Token has expired' });
        return;
    }

    if (payload.iss !== config.adminJwtIssuer) {
        await reply.status(401).send({ message: 'Invalid token issuer' });
        return;
    }

    if (!hasExpectedAudience(payload.aud, config.adminJwtAudience)) {
        await reply.status(401).send({ message: 'Invalid token audience' });
        return;
    }

    const role = typeof payload.role === 'string' ? payload.role.toLowerCase() : '';
    const allowedRoles = new Set(config.adminAllowedRoles.map((entry) => entry.toLowerCase()));
    if (!allowedRoles.has(role)) {
        await reply.status(403).send({ message: 'Forbidden' });
        return;
    }
}
