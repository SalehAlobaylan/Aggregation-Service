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

    const authority = personalizedPageRank(edges, trustedHosts);

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

    const res = await cmsClient.postCandidates({
        candidates,
        edges: edges.map((e) => ({ from_host: e.from, to_host: e.to, weight: e.weight })),
    });
    logger.info('Source graph built', { candidates: candidates.length, edges: edges.length, promoted: res.promoted });
    return { candidates: candidates.length, promoted: res.promoted };
}
