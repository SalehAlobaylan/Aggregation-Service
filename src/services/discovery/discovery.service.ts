/**
 * Discovery orchestration: search → resolve feeds → validate → score → dedupe →
 * cap. Returns candidates ready to POST to CMS for admin review.
 */
import { logger } from '../../observability/logger.js';
import { canonicalSourceKey } from '../../utils/canonical-source-key.js';
import { getSearchProvider } from './search-provider.js';
import { resolveFeeds } from './feed-resolver.js';
import { validateFeed } from './validator.js';
import { scoreConfidence } from './scorer.js';
import type { DiscoveryProfileInput, SuggestionCandidate } from './types.js';

export async function runDiscovery(profile: DiscoveryProfileInput): Promise<SuggestionCandidate[]> {
    const provider = getSearchProvider(profile.searchProvider);
    const maxSuggestions = profile.maxSuggestionsPerRun && profile.maxSuggestionsPerRun > 0
        ? profile.maxSuggestionsPerRun
        : 10;

    const sites = await provider.search(profile);
    logger.info('Discovery search returned sites', { profile: profile.name, count: sites.length, via: provider.via });

    const out: SuggestionCandidate[] = [];
    const seen = new Set<string>();
    const seenHosts = new Set<string>(); // one feed per host (kills /feed vs /rss dupes)

    for (const site of sites) {
        if (out.length >= maxSuggestions) break;

        let feeds;
        try {
            feeds = await resolveFeeds(site.siteUrl);
        } catch (error) {
            logger.debug('Feed resolution skipped', { siteUrl: site.siteUrl, error: error instanceof Error ? error.message : String(error) });
            continue;
        }

        for (const feed of feeds) {
            if (out.length >= maxSuggestions) break;

            const preKey = canonicalSourceKey(feed.feedUrl);
            if (!preKey || seen.has(preKey)) continue;
            seen.add(preKey);

            let validated;
            try {
                validated = await validateFeed(feed.feedUrl, profile.recencyDays);
            } catch (error) {
                logger.debug('Feed validation skipped', { feedUrl: feed.feedUrl, error: error instanceof Error ? error.message : String(error) });
                continue;
            }
            if (!validated) continue;

            const canonicalKey = canonicalSourceKey(validated.finalUrl);
            if (canonicalKey !== preKey) {
                if (seen.has(canonicalKey)) continue;
                seen.add(canonicalKey);
            }

            // One feed per host — collapses the same source exposed at /feed and
            // /rss (e.g. sport360) into a single candidate.
            let host = '';
            try { host = new URL(validated.finalUrl).hostname.replace(/^www\./, ''); } catch { /* keep */ }
            if (host) {
                if (seenHosts.has(host)) continue;
                seenHosts.add(host);
            }

            const titles = validated.sampleItems.map((s) => s.title);
            const confidence = scoreConfidence(profile.keywords ?? [], titles, validated.health);

            let hostname = site.siteUrl;
            try {
                hostname = new URL(site.siteUrl).hostname;
            } catch {
                // keep raw
            }

            out.push({
                name: site.title || validated.title || feed.title || hostname,
                type: 'RSS',
                feedUrl: validated.finalUrl,
                siteUrl: site.siteUrl,
                imageUrl: validated.imageUrl,
                language: validated.language,
                canonicalKey,
                confidence,
                health: validated.health,
                sampleItems: validated.sampleItems,
                discoveredVia: provider.via,
            });
        }
    }

    out.sort((a, b) => b.confidence - a.confidence);
    return out.slice(0, maxSuggestions);
}
