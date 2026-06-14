/**
 * Resolve a candidate SITE url to concrete RSS/Atom feed URLs, reusing the
 * existing feed-discovery service. The site host is SSRF-pre-validated before
 * we hand it to the resolver.
 */
import { feedDiscoveryService } from '../feed-discovery.service.js';
import { assertPublicUrl } from '../../utils/safe-fetch.js';

export interface ResolvedFeed {
    feedUrl: string;
    title?: string;
}

const MAX_FEEDS_PER_SITE = 3;

export async function resolveFeeds(siteUrl: string): Promise<ResolvedFeed[]> {
    await assertPublicUrl(siteUrl);
    const feeds = await feedDiscoveryService.discoverFeeds(siteUrl);
    const seen = new Set<string>();
    const out: ResolvedFeed[] = [];
    for (const f of feeds) {
        const url = (f.url ?? '').trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push({ feedUrl: url, title: f.title });
        if (out.length >= MAX_FEEDS_PER_SITE) break;
    }
    return out;
}
