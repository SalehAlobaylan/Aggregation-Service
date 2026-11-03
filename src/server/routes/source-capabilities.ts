import type { FastifyInstance } from 'fastify';
import { config } from '../../config/index.js';

// Configuration evidence only: never contact an upstream source or expose keys.
export function sourceCapabilities(enrichmentReady: boolean) {
    return {
        checked_at: new Date().toISOString(),
        providers: {
            RSS: { ready: true },
            WEBSITE: { ready: enrichmentReady, reason: enrichmentReady ? undefined : 'enrichment_unavailable' },
            TWITTER: { ready: enrichmentReady, reason: enrichmentReady ? undefined : 'enrichment_unavailable' },
            TWITTER_API: { ready: Boolean(process.env.TWITTER_BEARER_TOKEN), reason: process.env.TWITTER_BEARER_TOKEN ? undefined : 'twitter_api_not_configured' },
            TELEGRAM: { ready: Boolean(config.telegramApiId && config.telegramApiHash && config.telegramSessionString), reason: config.telegramApiId && config.telegramApiHash && config.telegramSessionString ? undefined : 'telegram_not_configured' },
            REDDIT: { ready: true },
        },
    };
}

export function registerSourceCapabilityRoutes(server: FastifyInstance) {
    server.get('/internal/source-capabilities', async (_request, reply) => {
        const enrichmentReady = await fetch(`${config.enrichmentBaseUrl.replace(/\/$/, '')}/ready`, { signal: AbortSignal.timeout(2000) })
            .then(response => response.ok).catch(() => false);
        reply.header('Cache-Control', 'no-store');
        return sourceCapabilities(enrichmentReady);
    });
}
