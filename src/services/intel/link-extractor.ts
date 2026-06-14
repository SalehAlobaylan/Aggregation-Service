/**
 * Extract external outbound hosts from a page (for the citation graph). Fetches
 * via safeFetch (SSRF + size cap + politeness), parses with JSDOM, collects
 * distinct external hosts, skipping the page's own host + obvious non-news
 * infrastructure (social, CDNs, ad/analytics).
 */
import { JSDOM } from 'jsdom';
import { safeFetch } from '../../utils/safe-fetch.js';

// Root domains to drop (matched as the host OR any subdomain): social, infra,
// app stores, aggregators, and corporate/policy sites — never news feeds.
const NON_NEWS = [
    'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'youtu.be',
    'tiktok.com', 'linkedin.com', 'whatsapp.com', 't.me', 'telegram.me', 'telegram.org',
    'pinterest.com', 'snapchat.com', 'flipboard.com', 'reddit.com', 'medium.com',
    'google.com', 'googletagmanager.com', 'gstatic.com', 'googleapis.com', 'doubleclick.net',
    'cloudflare.com', 'gravatar.com', 'w3.org', 'schema.org', 'apple.com',
    'wikipedia.org', 'archive.org', 'github.com', 'amazon.com', 'bit.ly',
    'warnermediaprivacy.com', 'nabd.com',
];

function hostOf(u: string): string {
    try {
        return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return '';
    }
}

function isInfra(host: string): boolean {
    for (const d of NON_NEWS) {
        if (host === d || host.endsWith('.' + d)) return true; // root or subdomain
    }
    // Functional subdomains (support.x.com, privacy.x.com, …) — never a feed.
    return /(^|\.)(cdn|static|assets|img|images|ads?|analytics|track|pixel|support|privacy|policy|legal|help|account|login|mail|developer|developers|api)\./.test(host);
}

export async function extractOutboundHosts(pageUrl: string, ownHost: string): Promise<string[]> {
    let res;
    try {
        res = await safeFetch(pageUrl, { rateLimit: false, timeoutMs: 10_000 });
    } catch {
        return [];
    }
    if (!res.ok || !res.body || !res.contentType.toLowerCase().includes('html')) {
        return [];
    }

    const dom = new JSDOM(res.body);
    const hosts = new Set<string>();
    dom.window.document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (!href.startsWith('http')) return;
        const h = hostOf(href);
        if (!h || h === ownHost) return;
        if (h.endsWith('.' + ownHost) || ownHost.endsWith('.' + h)) return; // same org
        if (isInfra(h)) return;
        hosts.add(h);
    });
    // free the DOM
    dom.window.close();
    return [...hosts];
}
