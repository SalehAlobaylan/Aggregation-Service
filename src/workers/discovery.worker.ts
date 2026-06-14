/**
 * Discovery Worker — runs a discovery sweep for a profile and posts the
 * resulting source candidates back to CMS for admin review.
 */
import { Job } from 'bullmq';
import { createWorker } from './base-worker.js';
import { QUEUE_NAMES, type DiscoveryJob } from '../queues/index.js';
import { runDiscovery } from '../services/discovery/discovery.service.js';
import { cmsClient } from '../cms/client.js';

export const discoveryWorker = createWorker({
    queueName: QUEUE_NAMES.DISCOVERY,
    concurrency: 1, // discovery is bursty + hits external APIs; keep it gentle
    processor: async (job: Job<DiscoveryJob>, jobLogger): Promise<void> => {
        const { profile } = job.data;
        jobLogger.info('Discovery sweep started', { profile: profile.name, profileId: profile.id });

        const candidates = await runDiscovery(profile);
        jobLogger.info('Discovery produced candidates', { profile: profile.name, count: candidates.length });

        if (candidates.length === 0) {
            return;
        }

        const result = await cmsClient.postSourceSuggestions({
            tenantId: profile.tenantId,
            profileId: profile.id,
            candidates: candidates.map((c) => ({
                name: c.name,
                type: c.type,
                feed_url: c.feedUrl,
                site_url: c.siteUrl ?? null,
                image_url: c.imageUrl ?? null,
                language: c.language ?? null,
                canonical_key: c.canonicalKey,
                confidence: c.confidence,
                health: c.health,
                sample_items: c.sampleItems,
                discovered_via: c.discoveredVia,
            })),
        });
        jobLogger.info('Discovery suggestions posted to CMS', { profile: profile.name, ...result });
    },
});
