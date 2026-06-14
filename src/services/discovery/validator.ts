/**
 * Validate a candidate feed: fetch via safeFetch (SSRF + size cap), parse with
 * rss-parser, enforce liveness + recency, capture sample items + health, and a
 * light language guess.
 */
import Parser from 'rss-parser';
import { safeFetch } from '../../utils/safe-fetch.js';
import type { FeedHealth, SampleItem } from './types.js';

const parser = new Parser({ timeout: 10_000 });

const MIN_ITEMS = 3;
const RECENCY_DAYS = 30;
// A larger sample gives a more representative topic estimate for relevance
// scoring (a 5-item sample can be dominated by unrepresentative promo items).
const SAMPLE_SIZE = 10;

export interface ValidatedFeed {
    finalUrl: string;
    title?: string;
    imageUrl?: string;
    language?: string;
    sampleItems: SampleItem[];
    health: FeedHealth;
}

function guessLanguage(text: string): string | undefined {
    if (!text) return undefined;
    // Arabic Unicode block — good enough for AR/EN routing.
    return /[؀-ۿ]/.test(text) ? 'ar' : 'en';
}

export async function validateFeed(feedUrl: string): Promise<ValidatedFeed | null> {
    // One GET per candidate feed — bounded by maxSuggestions — so skip the
    // per-host politeness limiter (it wrongly throttles same-host category feeds,
    // e.g. BBC Arabic's 7 topic feeds). SSRF + size caps still apply.
    const res = await safeFetch(feedUrl, { timeoutMs: 10_000, rateLimit: false });
    if (!res.ok || !res.body) {
        return null;
    }

    let feed: Awaited<ReturnType<typeof parser.parseString>>;
    try {
        feed = await parser.parseString(res.body);
    } catch {
        return null;
    }

    const items = feed.items ?? [];
    if (items.length < MIN_ITEMS) {
        return null;
    }

    const timestamps = items
        .map((i) => (i.isoDate ? Date.parse(i.isoDate) : NaN))
        .filter((n) => !Number.isNaN(n));
    const lastMs = timestamps.length > 0 ? Math.max(...timestamps) : NaN;

    // Reject only when we have dates AND the newest is stale — undated feeds pass.
    if (!Number.isNaN(lastMs) && lastMs < Date.now() - RECENCY_DAYS * 86_400_000) {
        return null;
    }

    const sampleItems: SampleItem[] = items.slice(0, SAMPLE_SIZE).map((i) => ({
        title: (i.title ?? '').trim(),
        url: i.link,
        published_at: i.isoDate ?? null,
    }));

    const language = guessLanguage(
        sampleItems.map((s) => s.title).join(' ') + ' ' + (feed.title ?? '')
    );

    return {
        finalUrl: res.url,
        title: feed.title?.trim(),
        imageUrl: feed.image?.url,
        language,
        sampleItems,
        health: {
            items_count: items.length,
            last_item_at: Number.isNaN(lastMs) ? null : new Date(lastMs).toISOString(),
            parse_ok: true,
        },
    };
}
