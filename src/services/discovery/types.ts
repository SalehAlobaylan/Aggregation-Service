import type { DiscoveryProfileInput } from '../../queues/schemas.js';

export type { DiscoveryProfileInput };

export interface SiteCandidate {
    siteUrl: string;
    title?: string;
    via: 'tavily' | 'crawl';
}

export interface SampleItem {
    title: string;
    url?: string;
    published_at?: string | null;
}

export interface FeedHealth {
    items_count: number;
    last_item_at: string | null;
    parse_ok: boolean;
}

export interface SuggestionCandidate {
    name: string;
    type: 'RSS';
    feedUrl: string;
    siteUrl?: string;
    imageUrl?: string;
    language?: string;
    canonicalKey: string;
    confidence: number;
    health: FeedHealth;
    sampleItems: SampleItem[];
    discoveredVia: 'tavily' | 'crawl';
}
