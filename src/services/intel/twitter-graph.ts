/**
 * Twitter/X contributor to the Source Intelligence Graph (interaction-graph).
 *
 * Discovery reads an account's public syndication timeline via Enrichment (no
 * login, no API key, no account-ban risk). An account's retweets + quote-tweets
 * + @mentions are citation edges (the X analog of Telegram forwards / RSS links);
 * its recent tweets are the items the CMS scores. Seeded from your APPROVED X
 * handles + a curated set of Arabic-news hubs that interact heavily (official
 * broadcast accounts rarely RT/quote, so curated hubs bootstrap the graph).
 * Candidates are validated (public, recent, Arabic, min followers) into ledger
 * candidates the CMS scores + promotes. Bounded + paced (syndication rate-limits
 * by IP — a 429 degrades to exists:false, never crashes the build).
 */
import {
    fetchTwitterProfile,
    fetchTwitterRecommendations,
    type TwitterProfileInfo,
} from '../../ai/enrichment-client.js';
import { logger } from '../../observability/logger.js';

export interface TwitterCandidate {
    username: string;
    via: 'x-retweet' | 'x-quote' | 'x-mention' | 'x-recommend';
    cocitation: number;
    sampleTitles: { title: string }[];
    feedHealth: { items_count: number; last_item_at: string | null; subscribers: number; listed?: number; image?: string };
}

// Strongest → weakest provenance, so a stronger edge type wins the displayed
// label when an account is found via multiple mechanisms. Recommendation is
// X's own curated relatedness; retweet is an explicit endorsement by your
// trusted source — both rank above the weaker quote/mention signals.
const VIA_RANK: Record<TwitterCandidate['via'], number> = {
    'x-recommend': 4,
    'x-retweet': 3,
    'x-quote': 2,
    'x-mention': 1,
};

export interface TwitterGraphResult {
    candidates: TwitterCandidate[];
    edges: { from: string; to: string; weight: number }[]; // x:<handle> nodes
}

/**
 * Curated Arabic-news X hubs that interact (RT/quote/mention) with other accounts
 * — verified at build. Bootstraps the interaction-graph since official broadcast
 * accounts rarely cross-reference. Code constant, not env (Config Discipline).
 */
const ARABIC_NEWS_X_HUBS = [
    'AlArabiya',
    'AlHadath',
    'SaudiNews50',
    'ajmwatn',
    'alekhbariyatv',
    'spagov',
];

const MAX_SEEDS = 16;
const MAX_RESOLVE = 24;
const MIN_FOLLOWERS = 10_000;
const MIN_RECENT_MSGS = 3;
const SEED_DELAY_MS = 400; // gentle — syndication rate-limits by IP

const isArabic = (t: string) => /[؀-ۿ]/.test(t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uname = (s: string) => s.replace(/^@/, '').toLowerCase().trim();
const recentCount = (info: TwitterProfileInfo, cutoff: number) =>
    info.posts.filter((p) => p.created_at && new Date(p.created_at).getTime() >= cutoff).length;
const latestMs = (info: TwitterProfileInfo) =>
    info.posts.reduce((m, p) => Math.max(m, p.created_at ? new Date(p.created_at).getTime() : 0), 0);

export async function buildTwitterGraph(
    seeds: string[],
    recencyDays: number,
): Promise<TwitterGraphResult> {
    const edges: { from: string; to: string; weight: number }[] = [];
    const candidates = new Map<string, { via: TwitterCandidate['via']; citedBy: Set<string> }>();

    const seedList = [...new Set([...seeds, ...ARABIC_NEWS_X_HUBS].map(uname))].slice(0, MAX_SEEDS);
    const seedSet = new Set(seedList);

    const addEdge = (from: string, to: string, via: TwitterCandidate['via']) => {
        const t = uname(to);
        if (!t || t === from || seedSet.has(t)) return;
        edges.push({ from: `x:${from}`, to: `x:${t}`, weight: 1 });
        const c = candidates.get(t) ?? { via, citedBy: new Set<string>() };
        c.citedBy.add(from);
        if (VIA_RANK[via] > VIA_RANK[c.via]) c.via = via;
        candidates.set(t, c);
    };

    // 1. Crawl seeds → interaction edges + candidate set.
    for (const seed of seedList) {
        try {
            const info = await fetchTwitterProfile(seed);
            if (!info.exists) continue;
            for (const h of info.retweeted) addEdge(seed, h, 'x-retweet');
            for (const h of info.quoted) addEdge(seed, h, 'x-quote');
            for (const h of info.mentioned) addEdge(seed, h, 'x-mention');
        } catch (err) {
            logger.debug('X seed crawl failed', { seed, error: (err as Error).message });
        }
        await sleep(SEED_DELAY_MS);
    }

    // 2. Resolve + validate candidates.
    const out: TwitterCandidate[] = [];
    const cutoff = Date.now() - recencyDays * 86_400_000;
    let resolved = 0;
    for (const [u, meta] of candidates) {
        if (resolved >= MAX_RESOLVE) break;
        resolved++;
        try {
            const info = await fetchTwitterProfile(u);
            if (!info.exists) continue;
            // GraphQL reliably reports followers; treat 0/unknown as below the floor.
            if (info.followers < MIN_FOLLOWERS) continue;
            if (recentCount(info, cutoff) < MIN_RECENT_MSGS) continue;
            const texts = info.posts.map((p) => p.text.trim()).filter(Boolean);
            if (!isArabic(texts.join(' '))) continue;

            const latest = latestMs(info);
            out.push({
                username: u,
                via: meta.via,
                cocitation: meta.citedBy.size,
                sampleTitles: texts.slice(0, 10).map((t) => ({ title: t.slice(0, 300) })),
                feedHealth: {
                    items_count: texts.length,
                    last_item_at: latest ? new Date(latest).toISOString() : null,
                    subscribers: info.followers || 0,
                    image: info.image_url ?? undefined,
                },
            });
        } catch (err) {
            logger.debug('X candidate resolve failed', { username: u, error: (err as Error).message });
        }
        await sleep(SEED_DELAY_MS);
    }

    logger.info('Twitter graph built', { seeds: seedList.length, candidates: out.length, edges: edges.length });
    return { candidates: out, edges };
}

const MAX_REC_SEEDS = 16;
const REC_LIMIT = 40;
const MIN_REC_FOLLOWERS = 10_000;
const MIN_REC_STATUSES = 50; // skip near-empty / dormant accounts (no post-date inline)
// X list-membership floor. When a seed has no real recommendation graph, X falls
// back to low-authority noise — those accounts sit in ~0 user lists (measured
// median 0-7) while genuine outlets are in 50+ (real-outlet min was 51). This is
// a sharper noise discriminator than followers and catches bought-follower spam
// that clears MIN_REC_FOLLOWERS.
const MIN_REC_LISTED = 20;

/**
 * Recommendations contributor — X's "who to follow" / قد يعجبك graph. For each
 * trusted seed, X returns accounts it considers SIMILAR (seed-relative). Each
 * recommendation carries inline followers/desc/statuses, so candidates validate
 * WITHOUT a profile re-fetch (cheaper than the interaction graph, and a separate
 * rate-limit bucket — won't starve the RT/quote crawl). Edges seed→recommended
 * feed PageRank so authority flows from your trusted accounts to their related
 * accounts. Guest-token only (no login, no account-ban risk).
 */
export async function buildTwitterRecommendations(seeds: string[]): Promise<TwitterGraphResult> {
    const edges: { from: string; to: string; weight: number }[] = [];
    const cands = new Map<string, { citedBy: Set<string>; name: string | null; followers: number; statuses: number; listed: number; description: string; isProtected: boolean; image: string | null }>();

    const seedList = [...new Set([...seeds, ...ARABIC_NEWS_X_HUBS].map(uname))].slice(0, MAX_REC_SEEDS);
    const seedSet = new Set(seedList);

    for (const seed of seedList) {
        try {
            const res = await fetchTwitterRecommendations(seed, { limit: REC_LIMIT });
            if (!res.exists) continue;
            for (const acc of res.recommendations) {
                const h = uname(acc.username);
                if (!h || h === seed || seedSet.has(h)) continue;
                edges.push({ from: `x:${seed}`, to: `x:${h}`, weight: 1 });
                const c = cands.get(h) ?? {
                    citedBy: new Set<string>(),
                    name: acc.name,
                    followers: acc.followers,
                    statuses: acc.statuses,
                    listed: acc.listed,
                    description: acc.description,
                    isProtected: acc.is_protected,
                    image: acc.image_url,
                };
                c.citedBy.add(seed);
                cands.set(h, c);
            }
        } catch (err) {
            logger.debug('X recommend crawl failed', { seed, error: (err as Error).message });
        }
        await sleep(SEED_DELAY_MS);
    }

    // Validate inline (no re-fetch): public, big enough, active, Arabic.
    const out: TwitterCandidate[] = [];
    for (const [h, meta] of cands) {
        if (meta.isProtected) continue;
        if (meta.followers < MIN_REC_FOLLOWERS) continue;
        if (meta.listed < MIN_REC_LISTED) continue;
        if (meta.statuses < MIN_REC_STATUSES) continue;
        if (!isArabic(`${meta.name ?? ''} ${meta.description}`)) continue;
        out.push({
            username: h,
            via: 'x-recommend',
            cocitation: meta.citedBy.size,
            sampleTitles: [meta.name, meta.description]
                .filter((t): t is string => Boolean(t))
                .map((t) => ({ title: t.slice(0, 300) })),
            // listed_count is X's own list-membership authority — a strong, free
            // newsworthiness proxy (major outlets sit in thousands of user lists).
            feedHealth: { items_count: meta.statuses, last_item_at: null, subscribers: meta.followers, listed: meta.listed, image: meta.image ?? undefined },
        });
    }

    // Surface the highest-confidence candidates first: co-recommendation (how many
    // trusted seeds suggested it) is the cleanest quality signal, then X list-
    // authority, then reach. Keeps the strongest at the front of the review queue.
    out.sort((a, b) =>
        b.cocitation - a.cocitation ||
        (b.feedHealth.listed ?? 0) - (a.feedHealth.listed ?? 0) ||
        b.feedHealth.subscribers - a.feedHealth.subscribers,
    );

    logger.info('Twitter recommendations built', { seeds: seedList.length, candidates: out.length, edges: edges.length });
    return { candidates: out, edges };
}

/**
 * Merge X candidate lists (interaction + recommendations) by handle into ONE row
 * per handle. REQUIRED before posting: CMS upserts candidates on (tenant, domain)
 * and Postgres ON CONFLICT errors if the same handle appears twice in one batch.
 * Strongest `via` wins the label; cocitation sums; the richer sample/health
 * (interaction's real tweets) wins over the recommendation's bio fallback.
 */
export function mergeTwitterCandidates(...lists: TwitterCandidate[][]): TwitterCandidate[] {
    const byHandle = new Map<string, TwitterCandidate>();
    for (const list of lists) {
        for (const c of list) {
            const existing = byHandle.get(c.username);
            if (!existing) {
                byHandle.set(c.username, { ...c });
                continue;
            }
            if (VIA_RANK[c.via] > VIA_RANK[existing.via]) existing.via = c.via;
            existing.cocitation += c.cocitation;
            if ((c.feedHealth.items_count ?? 0) > (existing.feedHealth.items_count ?? 0)) {
                existing.sampleTitles = c.sampleTitles;
                existing.feedHealth = c.feedHealth;
            }
        }
    }
    return [...byHandle.values()];
}
