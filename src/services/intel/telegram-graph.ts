/**
 * Telegram contributor to the Source Intelligence Graph (Scrapling forward-graph).
 *
 * Discovery reads the public `t.me/s/<channel>` preview via Enrichment (Scrapling
 * curl_cffi — no login, no MTProto session, no account-ban risk). A channel's
 * forwarded-from + in-post `t.me/` mentions are citation edges (the Telegram
 * analog of the RSS link-graph); its recent posts are the items the CMS scores.
 * Seeded from your APPROVED channels + a curated set of Arabic-news hubs that
 * cross-reference others (broadcast-only channels yield no edges). Candidates are
 * validated (public, recent, Arabic, min subscribers) into ledger candidates the
 * CMS scores + promotes. gramjs is used ONLY for ingesting approved channels, not
 * here — so this path can't trigger the gramjs update-loop crash.
 */
import { fetchTelegramChannel, type TelegramChannelInfo } from '../../ai/enrichment-client.js';
import { logger } from '../../observability/logger.js';

export interface TelegramCandidate {
    username: string;
    via: 'telegram-forward' | 'telegram-mention';
    cocitation: number;
    sampleTitles: { title: string }[];
    feedHealth: { items_count: number; last_item_at: string | null; subscribers: number; bio?: string };
}

export interface TelegramGraphResult {
    candidates: TelegramCandidate[];
    edges: { from: string; to: string; weight: number }[]; // tg:<username> nodes
}

/**
 * Curated Arabic-news hub channels that cross-reference other channels (verified
 * to expose a public t.me/s/ preview). Bootstraps the forward-graph since most
 * official broadcast channels never forward/link anyone. Code constant, not env
 * (Config Discipline) — promote to an admin list if it needs runtime tuning.
 */
const ARABIC_NEWS_TG_HUBS = [
    'QudsN',
    'gazaalannet',
    'alqastalps',
    'SerajSat',
    'eyeonpalestine2',
    'shihabagency2',
];

const MAX_SEEDS = 16;
const MAX_RESOLVE = 24;
const MIN_SUBSCRIBERS = 1000;
const MIN_RECENT_MSGS = 3;
const SEED_DELAY_MS = 200;

const isArabic = (t: string) => /[؀-ۿ]/.test(t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uname = (s: string) => s.replace(/^@/, '').toLowerCase().trim();
const recentCount = (info: TelegramChannelInfo, cutoff: number) =>
    info.posts.filter((p) => p.datetime && new Date(p.datetime).getTime() >= cutoff).length;
const latestMs = (info: TelegramChannelInfo) =>
    info.posts.reduce((m, p) => Math.max(m, p.datetime ? new Date(p.datetime).getTime() : 0), 0);

export async function buildTelegramGraph(
    seeds: string[],
    recencyDays: number,
): Promise<TelegramGraphResult> {
    const edges: { from: string; to: string; weight: number }[] = [];
    // candidate username -> provenance + set of seeds that cite it (co-citation).
    const candidates = new Map<string, { via: TelegramCandidate['via']; citedBy: Set<string> }>();

    const seedList = [...new Set([...seeds, ...ARABIC_NEWS_TG_HUBS].map(uname))].slice(0, MAX_SEEDS);
    const seedSet = new Set(seedList);

    const addEdge = (from: string, to: string, via: TelegramCandidate['via']) => {
        const t = uname(to);
        if (!t || t === from || seedSet.has(t)) return;
        edges.push({ from: `tg:${from}`, to: `tg:${t}`, weight: 1 });
        const c = candidates.get(t) ?? { via, citedBy: new Set<string>() };
        c.citedBy.add(from);
        // forwarded-from is a stronger signal than an in-text mention.
        if (via === 'telegram-forward') c.via = 'telegram-forward';
        candidates.set(t, c);
    };

    // 1. Crawl seeds → forward/mention edges + candidate set.
    for (const seed of seedList) {
        try {
            const info = await fetchTelegramChannel(seed);
            if (!info.exists) continue;
            for (const f of info.forwarded) addEdge(seed, f, 'telegram-forward');
            for (const m of info.mentioned) addEdge(seed, m, 'telegram-mention');
        } catch (err) {
            logger.debug('Telegram seed crawl failed', { seed, error: (err as Error).message });
        }
        await sleep(SEED_DELAY_MS);
    }

    // 2. Resolve + validate candidates.
    const out: TelegramCandidate[] = [];
    const cutoff = Date.now() - recencyDays * 86_400_000;
    let resolved = 0;
    for (const [u, meta] of candidates) {
        if (resolved >= MAX_RESOLVE) break;
        resolved++;
        try {
            const info = await fetchTelegramChannel(u);
            if (!info.exists) continue;
            if (info.subscribers && info.subscribers < MIN_SUBSCRIBERS) continue;
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
                    subscribers: info.subscribers || 0,
                    bio: info.title || undefined,
                },
            });
        } catch (err) {
            logger.debug('Telegram candidate resolve failed', { username: u, error: (err as Error).message });
        }
        await sleep(SEED_DELAY_MS);
    }

    logger.info('Telegram graph built', { seeds: seedList.length, candidates: out.length, edges: edges.length });
    return { candidates: out, edges };
}
