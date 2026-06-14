/**
 * scoreConfidence — pure lexical + health confidence for a candidate (no ML;
 * semantic relevance is a later, CMS-side slice). Range 0..1.
 */
import type { FeedHealth } from './types.js';

export function scoreConfidence(
    keywords: string[],
    sampleTitles: string[],
    health: FeedHealth
): number {
    const kw = keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
    const text = sampleTitles.join(' ').toLowerCase();

    // Keyword hit-rate across the sample (neutral 0.3 when no keywords given).
    let hits = 0;
    for (const k of kw) {
        if (text.includes(k)) hits++;
    }
    const keywordScore = kw.length > 0 ? hits / kw.length : 0.3;

    // Volume: more items → healthier (caps at 20).
    const volumeScore = Math.min(1, (health.items_count ?? 0) / 20);

    // Recency of the newest item.
    let recencyScore = 0.5;
    if (health.last_item_at) {
        const ageDays = (Date.now() - Date.parse(health.last_item_at)) / 86_400_000;
        recencyScore = ageDays <= 2 ? 1 : ageDays <= 7 ? 0.8 : ageDays <= 30 ? 0.5 : 0.2;
    }

    const score = 0.6 * keywordScore + 0.2 * volumeScore + 0.2 * recencyScore;
    return Math.round(score * 100) / 100;
}
