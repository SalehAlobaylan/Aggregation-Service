import { describe, it, expect } from 'vitest';
import { scoreConfidence } from '../../src/services/discovery/scorer.js';
import type { FeedHealth } from '../../src/services/discovery/types.js';

const freshHealth: FeedHealth = {
    items_count: 25,
    last_item_at: new Date().toISOString(),
    parse_ok: true,
};

describe('scoreConfidence', () => {
    it('scores higher when sample titles match keywords', () => {
        const onTopic = scoreConfidence(['economy', 'inflation'], ['Saudi economy grows', 'inflation slows'], freshHealth);
        const offTopic = scoreConfidence(['economy', 'inflation'], ['football results', 'movie reviews'], freshHealth);
        expect(onTopic).toBeGreaterThan(offTopic);
    });

    it('returns a value in [0,1]', () => {
        const s = scoreConfidence(['x'], ['y'], freshHealth);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
    });

    it('penalizes stale feeds', () => {
        const stale: FeedHealth = {
            items_count: 25,
            last_item_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
            parse_ok: true,
        };
        const fresh = scoreConfidence(['economy'], ['economy news'], freshHealth);
        const old = scoreConfidence(['economy'], ['economy news'], stale);
        expect(fresh).toBeGreaterThan(old);
    });

    it('uses a neutral keyword score when no keywords given', () => {
        const s = scoreConfidence([], ['anything'], freshHealth);
        expect(s).toBeGreaterThan(0);
    });
});
