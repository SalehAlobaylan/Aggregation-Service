import { describe, expect, it } from 'vitest';
import { classifyNewsCandidate } from '../../src/services/news-classifier.service.js';

describe('news-classifier.service', () => {
    it('flags high-confidence news when multiple strong signals are present', () => {
        const result = classifyNewsCandidate({
            title: 'Breaking: Government announced emergency statement',
            excerpt: 'Officials confirmed the update according to local media',
            bodyText: 'The minister said the parliament will hold an urgent session.',
            sourceName: 'Global News Agency',
            sourceVerified: true,
            publishedAt: new Date(),
            priorSignalScore: 3,
        });

        expect(result.likelyNews).toBe(true);
        expect(result.confidence).toBe('high');
        expect(result.score).toBeGreaterThanOrEqual(40);
        expect(result.categoryHints.length).toBeGreaterThan(0);
    });

    it('stays low-confidence for weak non-news text', () => {
        const result = classifyNewsCandidate({
            title: 'Morning motivation playlist',
            excerpt: 'Stay focused and positive',
            bodyText: 'A calm mix for your daily routine.',
            sourceName: 'Music Channel',
            sourceVerified: false,
            publishedAt: null,
            priorSignalScore: 0,
        });

        expect(result.likelyNews).toBe(false);
        expect(result.confidence).toBe('low');
        expect(result.score).toBeLessThan(24);
    });
});
