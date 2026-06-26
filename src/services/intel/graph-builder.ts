/**
 * Source Intelligence Graph builder.
 *
 * Gathers signals from your trusted graph — corpus citations (domains your own
 * content links) + link-graph (domains your approved sources link to) — builds
 * the citation graph, computes personalized-PageRank authority seeded on your
 * approved sources, resolves + validates feeds for the top candidates, and posts
 * the ledger + edges to CMS (which auto-promotes the best ones into review).
 */
import { logger } from '../../observability/logger.js';
import { cmsClient } from '../../cms/client.js';
import { canonicalSourceKey } from '../../utils/canonical-source-key.js';
import { resolveFeeds } from '../discovery/feed-resolver.js';
import { validateFeed } from '../discovery/validator.js';
import { extractOutboundHosts } from './link-extractor.js';
import { personalizedPageRank, type GraphEdge } from './pagerank.js';
import { buildTelegramGraph } from './telegram-graph.js';
import {
    buildTwitterGraph,
    buildTwitterRecommendations,
    mergeTwitterCandidates,
    type TwitterCandidate,
} from './twitter-graph.js';
import { buildPodcastGraph } from './podcast-graph.js';
import { buildYouTubeGraph } from './youtube-graph.js';

const MAX_SOURCES_TO_CRAWL = 8;
const MAX_CANDIDATES_TO_RESOLVE = 20;

interface CandidateSignal {
    citation: number;
    recent: number;
    cocite: number;
    via: Set<string>;
}

export async function buildSourceGraph(recencyDays = 30): Promise<{ candidates: number; promoted: number }> {
    const [corpus, approved] = await Promise.all([
        cmsClient.getCorpusCitations().catch(() => ({ data: [] as { domain: string; count: number; recent_count: number }[] })),
        cmsClient.getApprovedSourcePages().catch(() => ({ data: [] as { host: string; site_url: string; feed_url: string }[] })),
    ]);

    const trustedHosts = (approved.data ?? []).map((a) => a.host);
    const trustedSet = new Set(trustedHosts);

    // Crawl approved homepages → outbound citation edges + co-citation tally.
    const edges: GraphEdge[] = [];
    const cocite = new Map<string, Set<string>>();
    for (const src of (approved.data ?? []).slice(0, MAX_SOURCES_TO_CRAWL)) {
        const hosts = await extractOutboundHosts(src.site_url, src.host);
        for (const h of hosts) {
            edges.push({ from: src.host, to: h, weight: 1 });
            const s = cocite.get(h) ?? new Set<string>();
            s.add(src.host);
            cocite.set(h, s);
        }
    }

    // Telegram contributor — extends the citation graph to channels (gated).
    // Forwarded-from + t.me mentions are the Telegram analog of the link-graph.
    let cfg: {
        telegram_discovery_enabled?: boolean;
        twitter_discovery_enabled?: boolean;
        twitter_recommend_enabled?: boolean;
        youtube_discovery_enabled?: boolean;
        podcast_discovery_enabled?: boolean;
        apple_related_enabled?: boolean;
        youtube_related_enabled?: boolean;
    } = {};
    try {
        cfg = await cmsClient.getDiscoveryConfig();
    } catch {
        /* default off */
    }
    let tgCandidates: Awaited<ReturnType<typeof buildTelegramGraph>>['candidates'] = [];
    let xCandidates: Awaited<ReturnType<typeof buildTwitterGraph>>['candidates'] = [];
    let podCandidates: Awaited<ReturnType<typeof buildPodcastGraph>>['candidates'] = [];
    let ytCandidates: Awaited<ReturnType<typeof buildYouTubeGraph>>['candidates'] = [];
    const pagerankSeeds = [...trustedHosts];
    if (cfg.telegram_discovery_enabled) {
        try {
            const tgChannels = await cmsClient
                .getApprovedTelegramChannels()
                .catch(() => ({ data: [] as { username: string }[] }));
            const seedUsernames = (tgChannels.data ?? []).map((c) => c.username).filter(Boolean);
            const tg = await buildTelegramGraph(seedUsernames, recencyDays);
            tgCandidates = tg.candidates;
            for (const e of tg.edges) edges.push({ from: e.from, to: e.to, weight: e.weight });
            for (const u of seedUsernames) pagerankSeeds.push(`tg:${u.replace(/^@/, '').toLowerCase()}`);
        } catch (err) {
            logger.warn('Telegram discovery failed', { error: (err as Error).message });
        }
    }

    // Twitter/X contributors — interaction graph (retweet/quote/mention) +
    // recommendations ("who to follow" / قد يعجبك). Both seed off your approved
    // handles. Candidates MERGE by handle before posting (CMS upserts on handle;
    // a duplicate handle in one batch would error the ON CONFLICT insert).
    if (cfg.twitter_discovery_enabled || cfg.twitter_recommend_enabled) {
        try {
            const xHandles = await cmsClient
                .getApprovedTwitterHandles()
                .catch(() => ({ data: [] as { username: string }[] }));
            const seedHandles = (xHandles.data ?? []).map((c) => c.username).filter(Boolean);
            for (const u of seedHandles) pagerankSeeds.push(`x:${u.replace(/^@/, '').toLowerCase()}`);

            let interaction: TwitterCandidate[] = [];
            let recommend: TwitterCandidate[] = [];
            if (cfg.twitter_discovery_enabled) {
                const x = await buildTwitterGraph(seedHandles, recencyDays);
                interaction = x.candidates;
                for (const e of x.edges) edges.push({ from: e.from, to: e.to, weight: e.weight });
            }
            if (cfg.twitter_recommend_enabled) {
                const r = await buildTwitterRecommendations(seedHandles);
                recommend = r.candidates;
                for (const e of r.edges) edges.push({ from: e.from, to: e.to, weight: e.weight });
            }
            xCandidates = mergeTwitterCandidates(interaction, recommend);
        } catch (err) {
            logger.warn('Twitter discovery failed', { error: (err as Error).message });
        }
    }

    // YouTube contributor (media / For You) — guest InnerTube watch-next graph.
    // Seeds = approved channels; candidates carry yt: nodes + edges, isolated from
    // the news graph by category at promotion time (CMS). Free (no Data API quota).
    if (cfg.youtube_discovery_enabled) {
        try {
            const chans = await cmsClient
                .getApprovedYouTubeChannels()
                .catch(() => ({ data: [] as { channel: string }[] }));
            const seedRefs = (chans.data ?? []).map((c) => c.channel).filter(Boolean);
            const yt = await buildYouTubeGraph(seedRefs, recencyDays, {
                related: cfg.youtube_related_enabled,
            });
            ytCandidates = yt.candidates;
            for (const e of yt.edges) edges.push({ from: e.from, to: e.to, weight: e.weight });
            for (const id of yt.seedIds) pagerankSeeds.push(`yt:${id}`);
        } catch (err) {
            logger.warn('YouTube discovery failed', { error: (err as Error).message });
        }
    }

    // Podcast contributor (media / For You) — seed-relative iTunes adjacency.
    // Seeds = approved podcast feeds; candidates carry their own pod: nodes and
    // edges, isolated from the news graph by category at promotion time (CMS).
    if (cfg.podcast_discovery_enabled) {
        try {
            const feeds = await cmsClient
                .getApprovedPodcastFeeds()
                .catch(() => ({ data: [] as { feed_url: string }[] }));
            const seedFeeds = (feeds.data ?? []).map((f) => f.feed_url).filter(Boolean);
            const pod = await buildPodcastGraph(seedFeeds, recencyDays, {
                appleRelated: cfg.apple_related_enabled,
            });
            podCandidates = pod.candidates;
            for (const e of pod.edges) edges.push({ from: e.from, to: e.to, weight: e.weight });
            for (const f of seedFeeds) {
                const k = canonicalSourceKey(f);
                if (k) pagerankSeeds.push(`pod:${k}`);
            }
        } catch (err) {
            logger.warn('Podcast discovery failed', { error: (err as Error).message });
        }
    }

    const authority = personalizedPageRank(edges, pagerankSeeds);

    // Merge corpus + link-graph signals into a candidate map (exclude trusted).
    const candMap = new Map<string, CandidateSignal>();
    const ensure = (domain: string): CandidateSignal => {
        let e = candMap.get(domain);
        if (!e) {
            e = { citation: 0, recent: 0, cocite: 0, via: new Set() };
            candMap.set(domain, e);
        }
        return e;
    };
    for (const c of corpus.data ?? []) {
        if (!c.domain || trustedSet.has(c.domain)) continue;
        const e = ensure(c.domain);
        e.citation = c.count;
        e.recent = c.recent_count;
        e.via.add('corpus');
    }
    for (const [h, srcs] of cocite) {
        if (trustedSet.has(h)) continue;
        const e = ensure(h);
        e.cocite = srcs.size;
        e.via.add('linkgraph');
    }

    // Rank by authority, then resolve + validate the top N feeds.
    const ranked = [...candMap.entries()]
        .sort((a, b) => (authority.get(b[0]) ?? 0) - (authority.get(a[0]) ?? 0))
        .slice(0, MAX_CANDIDATES_TO_RESOLVE);

    const candidates = [];
    for (const [domain, sig] of ranked) {
        let resolvedFeedUrl: string | null = null;
        let feedValid = false;
        let sampleTitles: unknown[] = [];
        let feedHealth: unknown = null;
        try {
            const feeds = await resolveFeeds('https://' + domain);
            if (feeds[0]) {
                const v = await validateFeed(feeds[0].feedUrl, recencyDays);
                if (v) {
                    resolvedFeedUrl = v.finalUrl;
                    feedValid = true;
                    sampleTitles = v.sampleItems;
                    feedHealth = v.health;
                }
            }
        } catch {
            // unresolved — kept in the ledger as a candidate with no feed
        }
        const trend = sig.citation > 0 && sig.recent * 2 >= sig.citation ? 'rising' : 'flat';
        candidates.push({
            domain,
            kind: 'rss',
            canonical_key: resolvedFeedUrl ? canonicalSourceKey(resolvedFeedUrl) : 'https://' + domain,
            resolved_feed_url: resolvedFeedUrl,
            feed_valid: feedValid,
            citation_count: sig.citation,
            cocitation_count: sig.cocite,
            authority_score: authority.get(domain) ?? 0,
            trend,
            discovered_via: [...sig.via],
            sample_titles: sampleTitles,
            feed_health: feedHealth,
        });
    }

    // Telegram candidates → ledger rows (channel = domain, tg: namespaced key).
    for (const tc of tgCandidates) {
        candidates.push({
            domain: tc.username,
            kind: 'telegram',
            canonical_key: `tg:${tc.username}`,
            resolved_feed_url: `https://t.me/${tc.username}`,
            feed_valid: true,
            citation_count: 0,
            cocitation_count: tc.cocitation,
            authority_score: authority.get(`tg:${tc.username}`) ?? 0,
            trend: 'flat',
            discovered_via: [tc.via],
            sample_titles: tc.sampleTitles,
            feed_health: tc.feedHealth,
        });
    }

    // Twitter/X candidates → ledger rows (handle = domain, x: namespaced key).
    for (const xc of xCandidates) {
        candidates.push({
            domain: xc.username,
            kind: 'twitter',
            canonical_key: `x:${xc.username}`,
            resolved_feed_url: `https://x.com/${xc.username}`,
            feed_valid: true,
            citation_count: 0,
            cocitation_count: xc.cocitation,
            authority_score: authority.get(`x:${xc.username}`) ?? 0,
            trend: 'flat',
            discovered_via: [xc.via],
            sample_titles: xc.sampleTitles,
            feed_health: xc.feedHealth,
        });
    }

    // YouTube candidates → ledger rows (kind 'youtube', domain = channelId).
    for (const yc of ytCandidates) {
        candidates.push({
            domain: yc.channelId,
            kind: 'youtube',
            canonical_key: `yt:${yc.channelId}`,
            resolved_feed_url: `https://www.youtube.com/channel/${yc.channelId}`,
            feed_valid: true,
            citation_count: 0,
            cocitation_count: yc.cocitation,
            authority_score: authority.get(`yt:${yc.channelId}`) ?? 0,
            trend: 'flat',
            discovered_via: [yc.via],
            sample_titles: yc.sampleTitles,
            feed_health: yc.feedHealth,
        });
    }

    // Podcast candidates → ledger rows (kind 'podcast', resolves to the RSS feed).
    // Authority keyed on the pod:<feedKey> node so seed→candidate trust flows.
    for (const pc of podCandidates) {
        candidates.push({
            domain: pc.domain,
            kind: 'podcast',
            canonical_key: pc.canonicalKey,
            resolved_feed_url: pc.feedUrl,
            feed_valid: true,
            citation_count: 0,
            cocitation_count: pc.cocitation,
            authority_score: authority.get(`pod:${pc.canonicalKey}`) ?? 0,
            trend: 'flat',
            discovered_via: [pc.via],
            sample_titles: pc.sampleTitles,
            feed_health: pc.feedHealth,
        });
    }

    const res = await cmsClient.postCandidates({
        candidates,
        edges: edges.map((e) => ({ from_host: e.from, to_host: e.to, weight: e.weight })),
    });
    logger.info('Source graph built', { candidates: candidates.length, edges: edges.length, promoted: res.promoted });
    return { candidates: candidates.length, promoted: res.promoted };
}
