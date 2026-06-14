/**
 * canonicalSourceKey — stable dedupe key for a source URL.
 *
 * Lowercases host, strips a leading `www.`, forces https, drops the trailing
 * slash and known tracking params. Operates on an ALREADY-resolved URL — redirect
 * following to the final URL is done by safeFetch; this stays a pure function so
 * it is trivially unit-testable.
 */

const TRACKING_PARAMS = new Set([
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'fbclid',
    'gclid',
    'mc_cid',
    'mc_eid',
    'ref',
    'ref_src',
    'igshid',
]);

export function canonicalSourceKey(rawUrl: string): string {
    const trimmed = (rawUrl ?? '').trim();
    if (!trimmed) {
        return '';
    }
    try {
        const u = new URL(trimmed);

        let host = u.hostname.toLowerCase();
        if (host.startsWith('www.')) {
            host = host.slice(4);
        }

        const params = new URLSearchParams(u.search);
        for (const key of [...params.keys()]) {
            if (TRACKING_PARAMS.has(key.toLowerCase())) {
                params.delete(key);
            }
        }
        params.sort();
        const search = params.toString();

        const path = u.pathname.replace(/\/+$/, '');

        return `https://${host}${path}${search ? `?${search}` : ''}`.toLowerCase();
    } catch {
        return trimmed.toLowerCase();
    }
}
