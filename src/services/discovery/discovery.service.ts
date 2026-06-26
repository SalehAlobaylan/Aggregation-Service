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
import { searchYouTubeChannels, fetchYouTubeChannel } from '../../ai/enrichment-client.js';
import type { DiscoveryProfileInput, SuggestionCandidate } from './types.js';

export async function runDiscovery(profile: DiscoveryProfileInput): Promise<SuggestionCandidate[]> {
    const provider = getSearchProvider(profile);
    const isMedia = (profile.category ?? 'news') === 'media';
    const suggestionType: SuggestionCandidate['type'] = isMedia ? 'PODCAST' : 'RSS';
    const maxSuggestions = profile.maxSuggestionsPerRun && profile.maxSuggestionsPerRun > 0
        ? profile.maxSuggestionsPerRun
        : 10;

    const sites = await provider.search(profile);
    logger.info('Discovery search returned sites', { profile: profile.name, count: sites.length, via: provider.via });

    const out: SuggestionCandidate[] = [];
    const seen = new Set<string>();
    const seenHosts = new Set<string>(); // one feed per host (kills /feed vs /rss dupes)

    // Media (podcasts): iTunes returns feed URLs directly, so validate them in
    // PARALLEL batches. A deep keyword result set (40-50 shows) would otherwise
    // serialize through the news loop below into a multi-minute run.
    if (isMedia) {
        const BATCH = 6;
        const feedUrls = [...new Set(sites.map((s) => s.siteUrl))];
        const titleByUrl = new Map(sites.map((s) => [s.siteUrl, s.title]));
        for (let i = 0; i < feedUrls.length && out.length < maxSuggestions; i += BATCH) {
            const batch = feedUrls.slice(i, i + BATCH);
            const results = await Promise.all(batch.map(async (u) => {
                const pre = canonicalSourceKey(u);
                if (!pre || seen.has(pre)) return null;
                try {
                    const v = await validateFeed(u, profile.recencyDays);
                    return v ? { u, v, pre } : null;
                } catch {
                    return null;
                }
            }));
            for (const r of results) {
                if (!r || out.length >= maxSuggestions) continue;
                const canonicalKey = canonicalSourceKey(r.v.finalUrl);
                if (seen.has(canonicalKey)) continue;
                seen.add(r.pre);
                seen.add(canonicalKey);
                const titles = r.v.sampleItems.map((s) => s.title);
                out.push({
                    name: titleByUrl.get(r.u) || r.v.title || canonicalKey,
                    type: 'PODCAST',
                    feedUrl: r.v.finalUrl,
                    siteUrl: r.u,
                    imageUrl: r.v.imageUrl,
                    language: r.v.language,
                    canonicalKey,
                    confidence: scoreConfidence(profile.keywords ?? [], titles, r.v.health),
                    health: r.v.health,
                    sampleItems: r.v.sampleItems,
                    discoveredVia: 'itunes',
                });
            }
        }
    }

    for (const site of (isMedia ? [] : sites)) {
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

            // One feed per host — collapses the same NEWS outlet exposed at /feed
            // and /rss (e.g. sport360). Skipped for media: podcast hosts
            // (anchor.fm, megaphone, libsyn…) carry thousands of distinct shows,
            // so per-host dedup would wrongly collapse them to one candidate.
            let host = '';
            try { host = new URL(validated.finalUrl).hostname.replace(/^www\./, ''); } catch { /* keep */ }
            if (host && !isMedia) {
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
                type: suggestionType,
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

    // Media profiles ALSO discover YouTube channels by topic (the InnerTube
    // keyword net), symmetric with iTunes podcasts — on its own budget so
    // podcasts don't crowd it out. Degrades to empty if Enrichment is down.
    if (isMedia) {
        const queries = profile.keywords && profile.keywords.length > 0 ? profile.keywords : [profile.name];
        // Arabic-first roster: for an Arabic profile, drop channels with no Arabic
        // in their title/recent videos. Semantic relevance can't filter language
        // (Qwen is multilingual), so an English channel like "Primitive Technology"
        // would otherwise rank high for تقنية.
        const wantArabic = (profile.languages ?? []).includes('ar');
        const hasArabic = (t: string) => /[؀-ۿ]/.test(t);

        // 1. Gather distinct candidate channels from a couple of keyword searches.
        const candIds: { id: string; fallbackTitle: string | null }[] = [];
        const ytSeen = new Set<string>();
        for (const q of queries.slice(0, 2)) {
            let channels;
            try {
                channels = await searchYouTubeChannels(q, { limit: 6 });
            } catch (error) {
                logger.debug('YouTube search skipped', { q, error: error instanceof Error ? error.message : String(error) });
                continue;
            }
            for (const ch of channels) {
                if (!ch.channel_id || ytSeen.has(ch.channel_id) || seen.has(`yt:${ch.channel_id}`)) continue;
                ytSeen.add(ch.channel_id);
                candIds.push({ id: ch.channel_id, fallbackTitle: ch.title });
            }
        }

        // 2. Fetch channel details in PARALLEL batches — each InnerTube call is
        //    ~0.8s, so serial fetching dominated the run. Then gate + score.
        const BATCH = 5;
        for (let i = 0; i < candIds.length; i += BATCH) {
            if (out.filter((o) => o.type === 'YOUTUBE').length >= maxSuggestions) break;
            const batch = candIds.slice(i, i + BATCH);
            const infos = await Promise.all(batch.map((cc) => fetchYouTubeChannel(cc.id).catch(() => null)));
            for (let j = 0; j < infos.length; j++) {
                const info = infos[j];
                if (!info || !info.exists || !info.channel_id) continue;
                const titles = info.videos.map((v) => v.title.trim()).filter(Boolean);
                if (titles.length < 3) continue;
                if (wantArabic && !hasArabic(titles.join(' ') + ' ' + (info.title ?? ''))) continue;
                const canonicalKey = `yt:${info.channel_id}`;
                if (seen.has(canonicalKey)) continue;
                seen.add(canonicalKey);
                const health = { items_count: titles.length, last_item_at: null, parse_ok: true };
                out.push({
                    name: info.title || batch[j].fallbackTitle || info.channel_id,
                    type: 'YOUTUBE',
                    feedUrl: `https://www.youtube.com/channel/${info.channel_id}`,
                    imageUrl: info.image_url ?? undefined,
                    canonicalKey,
                    confidence: scoreConfidence(profile.keywords ?? [], titles, health),
                    health: {
                        ...health,
                        subscribers: info.subscribers || undefined,
                        image: info.image_url ?? undefined,
                        bio: info.title ?? undefined,
                        audio_first: info.audio_first,
                        category: info.category ?? undefined,
                        duration_sec: info.top_duration_sec || undefined,
                    },
                    sampleItems: titles.slice(0, 10).map((t) => ({ title: t })),
                    discoveredVia: 'youtube-search',
                });
            }
        }
    }

    out.sort((a, b) => b.confidence - a.confidence);
    // Media returns both nets (podcasts + YouTube); double the cap so one platform
    // doesn't squeeze out the other in the review queue.
    return out.slice(0, isMedia ? maxSuggestions * 2 : maxSuggestions);
}
