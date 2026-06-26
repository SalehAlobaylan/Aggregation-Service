import type { DiscoveryProfileInput } from '../../queues/schemas.js';

export type { DiscoveryProfileInput };

export type DiscoveryVia = 'tavily' | 'crawl' | 'itunes' | 'youtube-search';

export interface SiteCandidate {
    siteUrl: string;
    title?: string;
    via: DiscoveryVia;
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
    // Media channel signals (YouTube keyword candidates) surfaced on the card.
    subscribers?: number;
    image?: string;
    bio?: string;
    // Audio-first detection (YouTube): is the channel talk-driven (works as audio)
    // vs visual-first (Music/Gaming/Sports). category = dominant sampled category.
    audio_first?: boolean;
    category?: string;
    duration_sec?: number;
}

export interface SuggestionCandidate {
    name: string;
    type: 'RSS' | 'PODCAST' | 'YOUTUBE';
    feedUrl: string;
    siteUrl?: string;
    imageUrl?: string;
    language?: string;
    canonicalKey: string;
    confidence: number;
    health: FeedHealth;
    sampleItems: SampleItem[];
    discoveredVia: DiscoveryVia;
}
