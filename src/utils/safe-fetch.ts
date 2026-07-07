/**
 * safeFetch — the single hardened fetch chokepoint for source discovery.
 *
 * Defends against:
 *  - SSRF: rejects private / loopback / link-local / CGNAT IPs and non-http(s)
 *    schemes, re-checked on EVERY redirect hop (defeats DNS-rebinding).
 *  - XML / zip bombs: hard max-bytes streaming cap + request timeout.
 *  - Hammering sources we also ingest from: per-host politeness via the shared
 *    rate limiter.
 *
 * All discovery fetching (feed validation, crawl candidates) must go through here.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { rateLimiter } from '../services/rate-limiter.js';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = 'WahbBot/1.0 (Feed Discovery; +https://wahb.salehspace.dev)';
const ACCEPT = 'text/html,application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.8';

export class SSRFError extends Error {}
export class RateLimitedError extends Error {}

export interface SafeFetchOptions {
    timeoutMs?: number;
    headers?: Record<string, string>;
    method?: 'GET' | 'HEAD';
    /** Set false to skip the per-host rate limiter (default: enabled). */
    rateLimit?: boolean;
}

export interface SafeFetchResult {
    ok: boolean;
    status: number;
    url: string; // final URL after redirects
    body: string;
    contentType: string;
}

export interface SafeFetchResponseResult {
    response: Response;
    url: string;
}

function isPrivateIPv4(ip: string): boolean {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
        return true;
    }
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast / reserved
    return false;
}

function isPrivateIPv6(ip: string): boolean {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80')) return true; // link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique-local fc00::/7
    const mapped = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
    return false;
}

function ipBlocked(ip: string): boolean {
    if (net.isIPv4(ip)) return isPrivateIPv4(ip);
    if (net.isIPv6(ip)) return isPrivateIPv6(ip);
    return true; // unknown family → block
}

/**
 * Throws SSRFError if the URL's scheme is not http(s) or its host resolves to a
 * non-public address. Exported so callers can pre-validate before handing a URL
 * to a third-party fetcher.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
    let u: URL;
    try {
        u = new URL(rawUrl);
    } catch {
        throw new SSRFError(`invalid URL: ${rawUrl}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new SSRFError(`blocked scheme: ${u.protocol}`);
    }
    const host = u.hostname;
    if (net.isIP(host)) {
        if (ipBlocked(host)) throw new SSRFError(`blocked address: ${host}`);
        return;
    }
    let addrs: { address: string }[];
    try {
        addrs = await dns.lookup(host, { all: true });
    } catch {
        throw new SSRFError(`DNS resolution failed: ${host}`);
    }
    if (addrs.length === 0) {
        throw new SSRFError(`no addresses for host: ${host}`);
    }
    for (const a of addrs) {
        if (ipBlocked(a.address)) {
            throw new SSRFError(`blocked address for ${host}: ${a.address}`);
        }
    }
}

async function readCapped(resp: Response, maxBytes: number): Promise<string> {
    if (!resp.body) {
        return resp.text();
    }
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            total += value.length;
            if (total > maxBytes) {
                await reader.cancel();
                throw new Error('response exceeds max size');
            }
            chunks.push(value);
        }
    }
    return Buffer.concat(chunks).toString('utf-8');
}

export async function safeFetchResponse(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResponseResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let currentUrl = rawUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertPublicUrl(currentUrl); // re-checked every hop
        const u = new URL(currentUrl);

        if (opts.rateLimit !== false) {
            const rl = await rateLimiter.consumeRateLimit('RSS', u.hostname);
            if (!rl.allowed) {
                throw new RateLimitedError(`rate limited for host: ${u.hostname}`);
            }
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let resp: Response;
        try {
            resp = await fetch(u.toString(), {
                method: opts.method ?? 'GET',
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: ACCEPT,
                    ...(opts.headers ?? {}),
                },
            });
        } finally {
            clearTimeout(timer);
        }

        if (resp.status >= 300 && resp.status < 400) {
            const location = resp.headers.get('location');
            if (location) {
                currentUrl = new URL(location, u).toString();
                continue;
            }
        }

        return {
            response: resp,
            url: u.toString(),
        };
    }

    throw new Error('too many redirects');
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
    const { response: resp, url } = await safeFetchResponse(rawUrl, opts);
    const body = await readCapped(resp, MAX_BYTES);
    return {
        ok: resp.ok,
        status: resp.status,
        url,
        body,
        contentType: resp.headers.get('content-type') ?? '',
    };
}
