/**
 * Manual seed import: parse a pasted youtubei/v1 payload into the channels it
 * references, enrich each via guest InnerTube, and post them as suggestions for
 * admin review (the same review → approve → storage-guard path as discovered
 * channels). No stored credentials — the admin stays the authenticated session.
 */
import { logger } from '../../observability/logger.js';
import {
    parseYouTubeFeed,
    resolveYouTubeLinks,
    fetchYouTubeChannel,
    type ExtractedChannel,
} from '../../ai/enrichment-client.js';
import { scoreConfidence } from './scorer.js';
import { cmsClient } from '../../cms/client.js';
import type { SuggestionCandidate } from './types.js';

export interface ImportYouTubeInput {
    raw: unknown;
    profileId?: string;
    tenantId?: string;
    keywords?: string[];
}

export interface ImportYouTubeLinksInput {
    inputs: string[]; // @handles / channel URLs / video share links, one per item
    profileId?: string;
    tenantId?: string;
    keywords?: string[];
}

export interface ImportYouTubeResult {
    channels: number; // distinct channels resolved from the input
    imported: number; // suggestion candidates built
    upserted?: number;
    skipped?: number;
}

// Admin hand-picked these, so floor the confidence above the CMS MinConfidence
// gate — an imported channel must never be silently dropped for low keyword
// overlap. CMS still computes a relevance_score against the profile for ordering.
const IMPORT_CONFIDENCE_FLOOR = 0.5;

/**
 * Paste-a-link seed path: resolve YouTube references to channels, then enrich +
 * queue them — the same review → approve → storage-guard path as a JSON paste,
 * minus the 1 MB DevTools blob.
 */
export async function importYouTubeLinks(
    input: ImportYouTubeLinksInput,
): Promise<ImportYouTubeResult> {
    const refs = (input.inputs ?? []).map((s) => s.trim()).filter(Boolean);
    const channels = refs.length ? await resolveYouTubeLinks(refs) : [];
    logger.info('YouTube import resolved links', { refs: refs.length, channels: channels.length });
    return enrichAndQueue(channels, input);
}

export async function importYouTubeFeed(input: ImportYouTubeInput): Promise<ImportYouTubeResult> {
    const channels = await parseYouTubeFeed(input.raw);
    logger.info('YouTube import parsed channels', { count: channels.length });
    return enrichAndQueue(channels, input);
}

async function enrichAndQueue(
    channels: ExtractedChannel[],
    input: { profileId?: string; tenantId?: string; keywords?: string[] },
): Promise<ImportYouTubeResult> {
    if (channels.length === 0) {
        return { channels: 0, imported: 0 };
    }

    const seen = new Set<string>();
    const candidates: SuggestionCandidate[] = [];
    const pool = channels.slice(0, 40); // bound enrichment cost for a paste
    const BATCH = 5;
    for (let i = 0; i < pool.length; i += BATCH) {
        const batch = pool.slice(i, i + BATCH);
        const infos = await Promise.all(batch.map((c) => fetchYouTubeChannel(c.channel_id).catch(() => null)));
        for (let j = 0; j < infos.length; j++) {
            const src = batch[j];
            const info = infos[j];
            if (!info || !info.exists || !info.channel_id) continue;
            const canonicalKey = `yt:${info.channel_id}`;
            if (seen.has(canonicalKey)) continue;
            seen.add(canonicalKey);
            const titles = info.videos.map((v) => v.title.trim()).filter(Boolean);
            const health = { items_count: titles.length, last_item_at: null, parse_ok: true };
            candidates.push({
                name: info.title || src.title || info.channel_id,
                type: 'YOUTUBE',
                feedUrl: `https://www.youtube.com/channel/${info.channel_id}`,
                imageUrl: info.image_url ?? undefined,
                canonicalKey,
                confidence: Math.max(IMPORT_CONFIDENCE_FLOOR, scoreConfidence(input.keywords ?? [], titles, health)),
                health: {
                    ...health,
                    subscribers: info.subscribers || undefined,
                    image: info.image_url ?? undefined,
                    bio: info.title ?? undefined,
                    audio_first: info.audio_first,
                    category: info.category ?? undefined,
                    duration_sec: info.top_duration_sec || undefined,
                    is_podcast: src.is_podcast || undefined,
                    episode_count: src.episode_count || undefined,
                },
                sampleItems: titles.slice(0, 10).map((t) => ({ title: t })),
                discoveredVia: 'youtube-import',
            });
        }
    }

    if (candidates.length === 0) {
        return { channels: channels.length, imported: 0 };
    }

    const result = await cmsClient.postSourceSuggestions({
        tenantId: input.tenantId,
        profileId: input.profileId,
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
    logger.info('YouTube import posted suggestions to CMS', { channels: channels.length, ...result });
    return { channels: channels.length, imported: candidates.length, ...result };
}
