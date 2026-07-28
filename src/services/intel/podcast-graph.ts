/**
 * Podcast contributor to the Source Intelligence Graph (Pods / media).
 *
 * Seeds = your APPROVED podcast feeds. For each seed we fetch the feed, derive a
 * topical query from its title, and ask Apple's iTunes directory for adjacent
 * shows (the free, key-less directory net). Shows iTunes surfaces alongside a
 * trusted seed are topically-related candidates — the podcast analog of the RSS
 * link-graph / Telegram forward-graph. Each candidate feed is validated (recent,
 * parseable) and its recent episode titles become the text the CMS scores for
 * relevance; `pod:<feedKey>` nodes carry the seed→candidate edges into PageRank.
 *
 * The richer co-listen relation (Apple "Listeners Also Subscribed") is a separate
 * contributor added behind `apple_related_enabled` after a live probe.
 */
import { createHash } from 'crypto';
import { itunesSearch } from '../itunes-search.js';
import { validateFeed } from '../discovery/validator.js';
import { canonicalSourceKey } from '../../utils/canonical-source-key.js';
import { fetchApplePodcastRelated } from '../../ai/enrichment-client.js';
import { logger } from '../../observability/logger.js';

export interface PodcastCandidate {
    domain: string; // stable per-show id (feed host + short hash) — ledger uniqueness
    canonicalKey: string;
    feedUrl: string;
    via: 'podcast-itunes' | 'apple-related';
    cocitation: number;
    sampleTitles: { title: string }[];
    feedHealth: { items_count: number; last_item_at: string | null; image?: string; language?: string };
    imageUrl?: string;
    language?: string;
}

export interface PodcastGraphResult {
    candidates: PodcastCandidate[];
    edges: { from: string; to: string; weight: number }[]; // pod:<feedKey> nodes
}

const MAX_SEEDS = 16;
const MAX_RESOLVE = 24;
const PER_SEED_RESULTS = 8;
const APPLE_RELATED_PER_SEED = 12;
const SEED_DELAY_MS = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Stable, length-safe per-show id: host + short hash of the canonical key. Avoids
// collapsing distinct shows that share a host (megaphone/anchor/libsyn).
function podcastDomain(feedUrl: string, canonicalKey: string): string {
    let host = '';
    try {
        host = new URL(feedUrl).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        host = 'feed';
    }
    const h = createHash('sha1').update(canonicalKey).digest('hex').slice(0, 10);
    return `${host}#${h}`.slice(0, 255);
}

// Build a short topical query from a show title (drop boilerplate words).
function queryFromTitle(title: string): string {
    return title
        .replace(/podcast|show|بودكاست/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .slice(0, 4)
        .join(' ');
}

export async function buildPodcastGraph(
    seedFeeds: string[],
    recencyDays: number,
    opts: { appleRelated?: boolean } = {},
): Promise<PodcastGraphResult> {
    if (!itunesSearch.isEnabled()) {
        logger.warn('Podcast graph skipped: iTunes search disabled');
        return { candidates: [], edges: [] };
    }

    const edges: { from: string; to: string; weight: number }[] = [];
    // candidate feedKey -> { feedUrl, provenance, set of seed feedKeys (co-citation) }
    const found = new Map<string, { feedUrl: string; via: PodcastCandidate['via']; citedBy: Set<string> }>();
    const seedKeys = new Set<string>();
    const addCandidate = (seedKey: string, feedUrl: string, via: PodcastCandidate['via']) => {
        const candKey = canonicalSourceKey(feedUrl);
        if (!candKey || candKey === seedKey || seedKeys.has(candKey)) return;
        const entry = found.get(candKey) ?? { feedUrl, via, citedBy: new Set<string>() };
        entry.citedBy.add(seedKey);
        // Apple co-listen is a stronger signal than directory adjacency.
        if (via === 'apple-related') entry.via = 'apple-related';
        found.set(candKey, entry);
        edges.push({ from: `pod:${seedKey}`, to: `pod:${candKey}`, weight: 1 });
    };

    const seeds = [...new Set(seedFeeds.map((f) => f.trim()).filter(Boolean))].slice(0, MAX_SEEDS);

    // 1. For each seed: iTunes topical adjacency (always) + Apple co-listen shelf
    //    (gated by apple_related_enabled). Both seed the candidate set + edges.
    for (const seedUrl of seeds) {
        const seedKey = canonicalSourceKey(seedUrl);
        if (!seedKey) continue;
        seedKeys.add(seedKey);
        try {
            const seed = await validateFeed(seedUrl, recencyDays * 4); // seeds may be quieter
            const country = seed?.language === 'ar' ? 'SA' : 'US';
            const query = queryFromTitle(seed?.title ?? '');
            if (!query) continue;
            const res = await itunesSearch.searchPodcasts(query, PER_SEED_RESULTS, country);
            let seedCollectionId: number | null = null;
            for (const p of res.results) {
                if (!p.feedUrl) continue;
                // The seed itself surfaces in its own title query → grab its Apple id.
                if (canonicalSourceKey(p.feedUrl) === seedKey) {
                    seedCollectionId = p.collectionId;
                    continue;
                }
                addCandidate(seedKey, p.feedUrl, 'podcast-itunes');
            }

            // Apple "Listeners Also Subscribed" — the co-listen relation.
            if (opts.appleRelated && seedCollectionId) {
                try {
                    const rel = await fetchApplePodcastRelated(String(seedCollectionId), { country });
                    // Cap the per-seed iTunes lookups (each related id → one lookup,
                    // rate-limited) so a full seed set doesn't balloon the build.
                    for (const r of rel.related.slice(0, APPLE_RELATED_PER_SEED)) {
                        const look = await itunesSearch.lookupPodcast(Number(r.adam_id));
                        if (look?.feedUrl) addCandidate(seedKey, look.feedUrl, 'apple-related');
                        await sleep(120);
                    }
                } catch (err) {
                    logger.debug('Apple related failed', { seedUrl, error: (err as Error).message });
                }
            }
        } catch (err) {
            logger.debug('Podcast seed expand failed', { seedUrl, error: (err as Error).message });
        }
        await sleep(SEED_DELAY_MS);
    }

    // 2. Validate candidate feeds → ledger candidates.
    const out: PodcastCandidate[] = [];
    let resolved = 0;
    for (const [candKey, meta] of found) {
        if (resolved >= MAX_RESOLVE) break;
        resolved++;
        try {
            const v = await validateFeed(meta.feedUrl, recencyDays);
            if (!v) continue;
            const titles = v.sampleItems.map((s) => s.title.trim()).filter(Boolean);
            if (titles.length === 0) continue;
            out.push({
                domain: podcastDomain(v.finalUrl, candKey),
                canonicalKey: candKey,
                feedUrl: v.finalUrl,
                via: meta.via,
                cocitation: meta.citedBy.size,
                sampleTitles: titles.slice(0, 10).map((t) => ({ title: t.slice(0, 300) })),
                feedHealth: {
                    items_count: v.health.items_count,
                    last_item_at: v.health.last_item_at,
                    image: v.imageUrl,
                    language: v.language,
                },
                imageUrl: v.imageUrl,
                language: v.language,
            });
        } catch (err) {
            logger.debug('Podcast candidate validate failed', { feedUrl: meta.feedUrl, error: (err as Error).message });
        }
        await sleep(SEED_DELAY_MS);
    }

    logger.info('Podcast graph built', { seeds: seeds.length, candidates: out.length, edges: edges.length });
    return { candidates: out, edges };
}
