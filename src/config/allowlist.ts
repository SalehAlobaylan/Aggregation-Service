/**
 * Domain allowlist configuration
 * Controls which domains can be scraped for full article content
 */
import { readFile } from 'fs/promises';
import { config } from './index.js';
import { logger } from '../observability/logger.js';

// Default allowlist - major news domains
const DEFAULT_ALLOWLIST: string[] = [
    'reuters.com',
    'apnews.com',
    'bbc.com',
    'bbc.co.uk',
    'techcrunch.com',
    'theverge.com',
    'arstechnica.com',
    'wired.com',
    'engadget.com',
    'theguardian.com',
    'nytimes.com',
    'washingtonpost.com',
    'cnn.com',
    'npr.org',
    'aljazeera.com',
];

let allowlistCache: Set<string> | null = null;
let lastLoadTime = 0;
const CACHE_TTL = 300000; // 5 minutes

/**
 * Load allowlist from file or use defaults
 */
export async function loadAllowlist(): Promise<Set<string>> {
    const now = Date.now();

    // Return cached if fresh
    if (allowlistCache && now - lastLoadTime < CACHE_TTL) {
        return allowlistCache;
    }

    try {
        if (config.sourceAllowlistPath) {
            const content = await readFile(config.sourceAllowlistPath, 'utf-8');
            const parsed = JSON.parse(content);

            if (Array.isArray(parsed.domains)) {
                allowlistCache = new Set(parsed.domains.map((d: string) => d.toLowerCase()));
                logger.info('Loaded allowlist from file', {
                    path: config.sourceAllowlistPath,
                    count: allowlistCache.size
                });
            } else {
                throw new Error('Invalid allowlist format: expected { domains: [] }');
            }
        } else {
            allowlistCache = new Set(DEFAULT_ALLOWLIST);
            logger.debug('Using default allowlist', { count: allowlistCache.size });
        }
    } catch (error) {
        logger.warn('Failed to load allowlist, using defaults', { error });
        allowlistCache = new Set(DEFAULT_ALLOWLIST);
    }

    lastLoadTime = now;
    return allowlistCache;
}

/**
 * Check if a domain is allowlisted
 */
export async function isDomainAllowed(urlOrDomain: string): Promise<boolean> {
    const allowlist = await loadAllowlist();

    // Extract domain from URL if needed
    let domain: string;
    try {
        if (urlOrDomain.includes('://')) {
            const url = new URL(urlOrDomain);
            domain = url.hostname.toLowerCase();
        } else {
            domain = urlOrDomain.toLowerCase();
        }
    } catch {
        return false;
    }

    // Check exact match
    if (allowlist.has(domain)) {
        return true;
    }

    // Check without www prefix
    const withoutWww = domain.replace(/^www\./, '');
    if (allowlist.has(withoutWww)) {
        return true;
    }

    // Check if it's a subdomain of an allowed domain
    for (const allowed of allowlist) {
        if (domain.endsWith(`.${allowed}`)) {
            return true;
        }
    }

    return false;
}

/**
 * Get all allowlisted domains
 */
export async function getAllowedDomains(): Promise<string[]> {
    const allowlist = await loadAllowlist();
    return Array.from(allowlist);
}

export const allowlistConfig = {
    loadAllowlist,
    isDomainAllowed,
    getAllowedDomains,
};
