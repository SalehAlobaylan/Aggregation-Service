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
import { Agent, buildConnector, fetch as undiciFetch, type Response as UndiciResponse } from 'undici';
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
    /** Parent operation cancellation; never replaced by the per-request budget. */
    signal?: AbortSignal;
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
    response: UndiciResponse;
    url: string;
    signal: AbortSignal;
    close: () => Promise<void>;
}

interface ApprovedTarget {
    url: URL;
    addresses: string[];
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
    await resolveApprovedTarget(rawUrl);
}

async function resolveApprovedTarget(rawUrl: string): Promise<ApprovedTarget> {
    let u: URL;
    try {
        u = new URL(rawUrl);
    } catch {
        throw new SSRFError('invalid URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new SSRFError('blocked URL scheme');
    }
    if (u.username || u.password) {
        throw new SSRFError('URL credentials are not allowed');
    }
    const host = u.hostname;
    if (net.isIP(host)) {
        if (ipBlocked(host)) throw new SSRFError('blocked address');
        return { url: u, addresses: [host] };
    }
    let addrs: { address: string }[];
    try {
        addrs = await dns.lookup(host, { all: true });
    } catch {
        throw new SSRFError('DNS resolution failed');
    }
    if (addrs.length === 0) {
        throw new SSRFError('DNS resolution returned no addresses');
    }
    for (const a of addrs) {
        if (ipBlocked(a.address)) {
            throw new SSRFError('DNS resolution included a blocked address');
        }
    }
    return { url: u, addresses: addrs.map(({ address }) => address) };
}

function createBoundDispatcher(target: ApprovedTarget): Agent {
    const connector = buildConnector({ timeout: DEFAULT_TIMEOUT_MS });
    let nextAddress = 0;
    return new Agent({
        // Connect to one of the addresses validated for this exact hop. The
        // original hostname remains the HTTP Host and TLS SNI/certificate name.
        connect(options, callback) {
            const address = target.addresses[nextAddress++ % target.addresses.length]!;
            connector(bindConnectionOptions(options, target.url.hostname, address), callback);
        },
    });
}

function bindConnectionOptions<T extends { hostname: string; host?: string; servername?: string }>(
    options: T,
    hostname: string,
    address: string,
): T {
    return {
        ...options,
        hostname: address,
        host: address,
        servername: hostname,
    };
}

// Narrow pure hooks for adversarial unit tests. They expose no override path
// in production; the real dispatcher always receives resolver-approved IPs.
export const safeFetchTestUtils = {
    bindConnectionOptions,
};

async function closeResponseAndDispatcher(response: UndiciResponse, dispatcher: Agent): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
    await dispatcher.close().catch(async () => dispatcher.destroy());
}

async function readCapped(resp: UndiciResponse, maxBytes: number, signal: AbortSignal): Promise<string> {
    if (!resp.body) {
        if (signal.aborted) throw signal.reason;
        return resp.text();
    }
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            if (signal.aborted) throw signal.reason;
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
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf-8');
}

export async function safeFetchResponse(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResponseResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let currentUrl = rawUrl;
    const requestTimeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, requestTimeout]) : requestTimeout;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (signal.aborted) throw signal.reason;
        const target = await resolveApprovedTarget(currentUrl); // re-resolve and bind every hop
        const u = target.url;

        if (opts.rateLimit !== false) {
            const rl = await rateLimiter.consumeRateLimit('RSS', u.hostname);
            if (!rl.allowed) {
                throw new RateLimitedError(`rate limited for host: ${u.hostname}`);
            }
        }

        const dispatcher = createBoundDispatcher(target);
        let resp: UndiciResponse;
        try {
            resp = await undiciFetch(u.toString(), {
                method: opts.method ?? 'GET',
                redirect: 'manual',
                signal,
                dispatcher,
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: ACCEPT,
                    ...(opts.headers ?? {}),
                },
            });
        } catch (error) {
            await dispatcher.destroy();
            throw error;
        }

        if (resp.status >= 300 && resp.status < 400) {
            const location = resp.headers.get('location');
            if (location) {
                currentUrl = new URL(location, u).toString();
                await closeResponseAndDispatcher(resp, dispatcher);
                continue;
            }
        }

        return {
            response: resp,
            url: u.toString(),
            signal,
            close: () => closeResponseAndDispatcher(resp, dispatcher),
        };
    }

    throw new Error('too many redirects');
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
    const { response: resp, url, signal, close } = await safeFetchResponse(rawUrl, opts);
    try {
        const body = await readCapped(resp, MAX_BYTES, signal);
        return {
            ok: resp.ok,
            status: resp.status,
            url,
            body,
            contentType: resp.headers.get('content-type') ?? '',
        };
    } finally {
        await close();
    }
}
