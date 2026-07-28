/**
 * YouTube contributor to the Source Intelligence Graph (Pods / media).
 *
 * Reads channels via Enrichment's guest InnerTube reader (no API key, no quota —
 * the paid Data API stays reserved for post-approval ingestion). Seeds = your
 * APPROVED YouTube channels; each seed's watch-next graph surfaces the channels
 * YouTube shows alongside it (the analog of forwards/retweets). Surfaced channels
 * become candidates: their recent video titles are the text CMS scores for
 * relevance, subscribers feed the authority signal. `yt:<channelId>` nodes carry
 * seed→candidate edges into PageRank. Failures degrade to empty (graceful).
 */
import { fetchYouTubeChannel, fetchYouTubeRelated } from '../../ai/enrichment-client.js';
import { logger } from '../../observability/logger.js';

export interface YouTubeCandidate {
    channelId: string;
    title: string | null;
    via: 'youtube-watchnext';
    cocitation: number;
    sampleTitles: { title: string }[];
    feedHealth: {
        items_count: number;
        last_item_at: string | null;
        subscribers: number;
        image?: string;
        bio?: string;
        audio_first?: boolean;
        category?: string;
        duration_sec?: number;
    };
    imageUrl?: string;
}

export interface YouTubeGraphResult {
    candidates: YouTubeCandidate[];
    edges: { from: string; to: string; weight: number }[]; // yt:<channelId> nodes
    seedIds: string[]; // resolved seed channel ids (for PageRank seeding)
}

const MAX_SEEDS = 12;
const MAX_RESOLVE = 24;
const MIN_SUBSCRIBERS = 5000;
const MIN_VIDEOS = 3;
const SEED_DELAY_MS = 250;

const isArabic = (t: string) => /[؀-ۿ]/.test(t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function buildYouTubeGraph(
    seedRefs: string[],
    _recencyDays: number,
    opts: { related?: boolean } = {},
): Promise<YouTubeGraphResult> {
    // youtube_related_enabled widens exploration (YouTube retired featured
    // channels, so "deeper relations" = a larger watch-next candidate pool).
    const maxSeeds = opts.related ? MAX_SEEDS * 2 : MAX_SEEDS;
    const maxResolve = opts.related ? MAX_RESOLVE * 2 : MAX_RESOLVE;
    const edges: { from: string; to: string; weight: number }[] = [];
    const candidates = new Map<string, { citedBy: Set<string> }>();
    const seedIds = new Set<string>();

    const seeds = [...new Set(seedRefs.map((s) => s.trim()).filter(Boolean))].slice(0, maxSeeds);

    // 1. Resolve each seed + its watch-next graph → candidate channels + edges.
    for (const ref of seeds) {
        try {
            const seed = await fetchYouTubeChannel(ref);
            if (!seed.exists || !seed.channel_id) continue;
            seedIds.add(seed.channel_id);
            const rel = await fetchYouTubeRelated(ref);
            for (const r of rel.related) {
                if (!r.channel_id || r.channel_id === seed.channel_id || seedIds.has(r.channel_id)) continue;
                edges.push({ from: `yt:${seed.channel_id}`, to: `yt:${r.channel_id}`, weight: 1 });
                const c = candidates.get(r.channel_id) ?? { citedBy: new Set<string>() };
                c.citedBy.add(seed.channel_id);
                candidates.set(r.channel_id, c);
            }
        } catch (err) {
            logger.debug('YouTube seed expand failed', { ref, error: (err as Error).message });
        }
        await sleep(SEED_DELAY_MS);
    }

    // 2. Resolve + validate candidate channels.
    const out: YouTubeCandidate[] = [];
    let resolved = 0;
    for (const [cid, meta] of candidates) {
        if (resolved >= maxResolve) break;
        resolved++;
        try {
            const info = await fetchYouTubeChannel(cid);
            if (!info.exists || !info.channel_id) continue;
            if (info.subscribers && info.subscribers < MIN_SUBSCRIBERS) continue;
            const titles = info.videos.map((v) => v.title.trim()).filter(Boolean);
            if (titles.length < MIN_VIDEOS) continue;
            // Arabic-first roster: skip channels with no Arabic in recent titles.
            if (!isArabic(titles.join(' ') + ' ' + (info.title ?? ''))) continue;

            out.push({
                channelId: info.channel_id,
                title: info.title,
                via: 'youtube-watchnext',
                cocitation: meta.citedBy.size,
                sampleTitles: titles.slice(0, 12).map((t) => ({ title: t.slice(0, 300) })),
                feedHealth: {
                    items_count: titles.length,
                    last_item_at: null,
                    subscribers: info.subscribers || 0,
                    image: info.image_url ?? undefined,
                    bio: info.title ?? undefined,
                    audio_first: info.audio_first,
                    category: info.category ?? undefined,
                    duration_sec: info.top_duration_sec || undefined,
                },
                imageUrl: info.image_url ?? undefined,
            });
        } catch (err) {
            logger.debug('YouTube candidate resolve failed', { channelId: cid, error: (err as Error).message });
        }
        await sleep(SEED_DELAY_MS);
    }

    logger.info('YouTube graph built', { seeds: seeds.length, candidates: out.length, edges: edges.length });
    return { candidates: out, edges, seedIds: [...seedIds] };
}
