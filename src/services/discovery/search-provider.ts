/**
 * Source search providers — find candidate news SITE URLs for a profile.
 *
 * TavilySearchProvider does true open-web discovery (needs TAVILY_API_KEY).
 * CrawlSearchProvider is a degraded seed-expansion fallback when no key is set:
 * it returns a small static set of broad news outlets to validate against the
 * profile's keywords. (Later slices add link-graph + corpus-mining nets here.)
 */
import { config } from '../../config/index.js';
import { logger } from '../../observability/logger.js';
import { itunesSearch } from '../itunes-search.js';
import type { DiscoveryProfileInput, DiscoveryVia, SiteCandidate } from './types.js';

export interface SourceSearchProvider {
    readonly via: DiscoveryVia;
    search(profile: DiscoveryProfileInput): Promise<SiteCandidate[]>;
}

function isArabic(profile: DiscoveryProfileInput): boolean {
    return (profile.languages ?? []).includes('ar');
}

// Native-language queries: an Arabic profile must search Arabic ("news rss feed"
// in English pulls back English outlets that score poorly against an Arabic
// interest). Bias Tavily toward Arabic news domains via include_domains.
function buildQueries(profile: DiscoveryProfileInput): string[] {
    const terms = (profile.keywords && profile.keywords.length > 0 ? profile.keywords : [profile.name]).join(' ');
    if (isArabic(profile)) {
        return [`${terms} أخبار`, `أفضل المواقع الإخبارية العربية عن ${terms}`];
    }
    return [`${terms} news rss feed`];
}

// Known Arabic news domains — used as a Tavily include_domains bias so Arabic
// profiles get Arabic candidates (not a hard restriction across both queries).
const ARABIC_NEWS_DOMAINS = [
    'aljazeera.net', 'alarabiya.net', 'skynewsarabia.com', 'arabic.cnn.com', 'arabic.rt.com',
    'bbc.com', 'almasryalyoum.com', 'alhadath.net', 'sport360.com', 'aitnews.com', 'youm7.com',
    'argaam.com', 'alyaum.com', 'annahar.com', 'alquds.co.uk', 'emaratalyoum.com', 'akhbarak.net',
];

class TavilySearchProvider implements SourceSearchProvider {
    readonly via = 'tavily' as const;
    constructor(private readonly apiKey: string) {}

    async search(profile: DiscoveryProfileInput): Promise<SiteCandidate[]> {
        const out: SiteCandidate[] = [];
        const seen = new Set<string>();
        for (const query of buildQueries(profile)) {
            try {
                const resp = await fetch('https://api.tavily.com/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        api_key: this.apiKey,
                        query,
                        topic: 'news',
                        search_depth: 'basic',
                        max_results: 10,
                        ...(isArabic(profile) ? { include_domains: ARABIC_NEWS_DOMAINS } : {}),
                    }),
                });
                if (!resp.ok) {
                    logger.warn('Tavily search failed', { status: resp.status, query });
                    continue;
                }
                const data = (await resp.json()) as { results?: { url: string; title?: string }[] };
                for (const r of data.results ?? []) {
                    try {
                        const origin = new URL(r.url).origin;
                        if (seen.has(origin)) continue;
                        seen.add(origin);
                        out.push({ siteUrl: origin, title: r.title, via: 'tavily' });
                    } catch {
                        // skip malformed result URL
                    }
                }
            } catch (error) {
                logger.warn('Tavily query error', { query, error: error instanceof Error ? error.message : String(error) });
            }
        }
        return out;
    }
}

// Verified-working Arabic news RSS feeds spanning topics (general, politics,
// world, sports, sci-tech, business, culture). Used as the crawl-only candidate
// catalog when no search API key is set; per-profile semantic relevance scoring
// (CMS-side) then surfaces the on-topic ones. Each was probed live for valid RSS
// + recent Arabic items. Direct feed URLs — the resolver returns them as-is.
const CRAWL_SEED_FEEDS: { url: string; name: string }[] = [
    // General / politics (broad Arabic news)
    { url: 'https://www.aljazeera.net/aljazeerarss/a7c186be-1baa-4bd4-9d80-a84db769f779/73d0e1b4-532f-45ef-b135-bfdff8b8cab9', name: 'الجزيرة نت' },
    { url: 'https://www.skynewsarabia.com/rss', name: 'سكاي نيوز عربية' },
    { url: 'https://arabic.cnn.com/api/v1/rss/rss.xml', name: 'CNN بالعربية' },
    { url: 'https://arabic.rt.com/rss/', name: 'RT عربي' },
    { url: 'https://www.almasryalyoum.com/rss/rssfeeds', name: 'المصري اليوم' },
    { url: 'https://feeds.bbci.co.uk/arabic/rss.xml', name: 'BBC عربي' },
    { url: 'https://www.independentarabia.com/rss.xml', name: 'اندبندنت عربية' },
    // Sports (topic-specific)
    { url: 'https://arabic.sport360.com/feed', name: 'سبورت 360 عربية' },
    // Technology (topic-specific)
    { url: 'https://www.tech-wd.com/wd/feed/', name: 'عالم التقنية' },
    { url: 'https://www.unlimit-tech.com/feed/', name: 'أنليميتد تك' },
    // Economy / business (topic-specific)
    { url: 'https://sa.investing.com/rss/news.rss', name: 'Investing عربية' },
    { url: 'https://arabic.cnbc.com/feed/', name: 'CNBC عربية' },
    // Politics / Middle East (topic-specific)
    { url: 'https://www.france24.com/ar/الشرق-الأوسط/rss', name: 'فرانس24 — الشرق الأوسط' },
    { url: 'https://www.youm7.com/rss/SectionRss?SectionID=88', name: 'اليوم السابع — أخبار عربية' },
    // Culture / lifestyle
    { url: 'https://www.sayidaty.net/rss.xml', name: 'سيدتي' },
];

function catalogCandidates(): SiteCandidate[] {
    return CRAWL_SEED_FEEDS.map((f) => ({ siteUrl: f.url, title: f.name, via: 'crawl' as const }));
}

/**
 * Hybrid: Tavily open-web search (when keyed) MERGED with the curated Arabic
 * catalog. The catalog guarantees high-quality on-topic Arabic feeds are always
 * in the candidate pool; per-profile relevance scoring (CMS) ranks everything.
 */
class HybridSearchProvider implements SourceSearchProvider {
    readonly via: 'tavily' | 'crawl';
    constructor(private readonly tavily?: TavilySearchProvider) {
        this.via = tavily ? 'tavily' : 'crawl';
    }
    async search(profile: DiscoveryProfileInput): Promise<SiteCandidate[]> {
        const out: SiteCandidate[] = [];
        const seen = new Set<string>();
        const add = (c: SiteCandidate) => {
            if (!seen.has(c.siteUrl)) { seen.add(c.siteUrl); out.push(c); }
        };
        if (this.tavily) {
            try {
                for (const c of await this.tavily.search(profile)) add(c);
            } catch (error) {
                logger.warn('Tavily search failed; using catalog only', { error: error instanceof Error ? error.message : String(error) });
            }
        }
        for (const c of catalogCandidates()) add(c);
        return out;
    }
}

// Podcast discovery for media profiles — Apple's iTunes Search is the open-web
// directory net (the Tavily analog). Returns podcast RSS feed URLs directly; the
// existing resolver/validator treat them as RSS. Native-language terms + a
// language-matched storefront so Arabic profiles get Arabic shows.
class ItunesSearchProvider implements SourceSearchProvider {
    readonly via = 'itunes' as const;
    async search(profile: DiscoveryProfileInput): Promise<SiteCandidate[]> {
        if (!itunesSearch.isEnabled()) {
            logger.warn('iTunes search disabled — no podcast discovery candidates');
            return [];
        }
        const country = (profile.languages ?? []).includes('ar') ? 'SA' : 'US';
        const terms = profile.keywords && profile.keywords.length > 0 ? profile.keywords : [profile.name];
        const out: SiteCandidate[] = [];
        const seen = new Set<string>();
        for (const term of terms.slice(0, 4)) {
            try {
                const res = await itunesSearch.searchPodcasts(term, 15, country);
                for (const p of res.results) {
                    if (!p.feedUrl || seen.has(p.feedUrl)) continue;
                    seen.add(p.feedUrl);
                    out.push({ siteUrl: p.feedUrl, title: p.collectionName, via: 'itunes' });
                }
            } catch (error) {
                logger.warn('iTunes podcast search error', { term, error: error instanceof Error ? error.message : String(error) });
            }
        }
        return out;
    }
}

export function getSearchProvider(profile: DiscoveryProfileInput): SourceSearchProvider {
    // Media profiles discover podcasts via iTunes; news profiles use Tavily+catalog.
    if ((profile.category ?? 'news') === 'media') {
        return new ItunesSearchProvider();
    }
    // 'crawl' forces catalog-only; 'tavily'/'auto'/unset use Tavily when keyed.
    const wantTavily = profile.searchProvider !== 'crawl';
    const tavily = wantTavily && config.tavilyApiKey ? new TavilySearchProvider(config.tavilyApiKey) : undefined;
    if (wantTavily && !tavily) {
        logger.warn('TAVILY_API_KEY not set — discovery using curated catalog only');
    }
    return new HybridSearchProvider(tavily);
}
