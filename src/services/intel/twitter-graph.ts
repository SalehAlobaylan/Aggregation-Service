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
import { fetchTwitterProfile, type TwitterProfileInfo } from '../../ai/enrichment-client.js';
import { logger } from '../../observability/logger.js';

export interface TwitterCandidate {
    username: string;
    via: 'x-retweet' | 'x-quote' | 'x-mention';
    cocitation: number;
    sampleTitles: { title: string }[];
    feedHealth: { items_count: number; last_item_at: string | null; subscribers: number };
}

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
    // strongest → weakest provenance, so a stronger edge type wins the label.
    const rank: Record<TwitterCandidate['via'], number> = { 'x-retweet': 3, 'x-quote': 2, 'x-mention': 1 };

    const addEdge = (from: string, to: string, via: TwitterCandidate['via']) => {
        const t = uname(to);
        if (!t || t === from || seedSet.has(t)) return;
        edges.push({ from: `x:${from}`, to: `x:${t}`, weight: 1 });
        const c = candidates.get(t) ?? { via, citedBy: new Set<string>() };
        c.citedBy.add(from);
        if (rank[via] > rank[c.via]) c.via = via;
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
