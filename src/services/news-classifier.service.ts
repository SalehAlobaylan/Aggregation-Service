/**
 * Lightweight news classifier for ingestion-time scoring.
 * Produces a structured metadata.news object for downstream ranking/filtering.
 */

export type NewsConfidence = 'low' | 'medium' | 'high';

export interface NewsClassification {
    version: 'v1';
    likelyNews: boolean;
    score: number;
    confidence: NewsConfidence;
    categoryHints: string[];
    matchedKeywords: string[];
    signals: {
        hasBreakingPrefix: boolean;
        verifiedSource: boolean;
        sourceLooksNews: boolean;
        hasAttribution: boolean;
        recencyHours: number | null;
    };
}

export interface NewsClassifierInput {
    title: string;
    excerpt?: string | null;
    bodyText?: string | null;
    publishedAt?: Date | null;
    sourceName?: string | null;
    sourceVerified?: boolean;
    priorSignalScore?: number;
}

const NEWS_KEYWORD_WEIGHTS: Array<{ keyword: string; weight: number; category: string }> = [
    { keyword: 'breaking', weight: 8, category: 'general' },
    { keyword: 'urgent', weight: 7, category: 'general' },
    { keyword: 'news', weight: 5, category: 'general' },
    { keyword: 'statement', weight: 4, category: 'politics' },
    { keyword: 'announced', weight: 4, category: 'politics' },
    { keyword: 'minister', weight: 6, category: 'politics' },
    { keyword: 'government', weight: 6, category: 'politics' },
    { keyword: 'president', weight: 6, category: 'politics' },
    { keyword: 'parliament', weight: 6, category: 'politics' },
    { keyword: 'election', weight: 6, category: 'politics' },
    { keyword: 'economy', weight: 5, category: 'economy' },
    { keyword: 'inflation', weight: 5, category: 'economy' },
    { keyword: 'market', weight: 4, category: 'economy' },
    { keyword: 'conflict', weight: 6, category: 'conflict' },
    { keyword: 'attack', weight: 6, category: 'conflict' },
    { keyword: 'ceasefire', weight: 6, category: 'conflict' },
    { keyword: 'earthquake', weight: 7, category: 'disaster' },
    { keyword: 'flood', weight: 6, category: 'disaster' },
    { keyword: 'storm', weight: 5, category: 'disaster' },
];

const NEWS_SOURCE_PATTERN = /\b(news|press|agency|journal|media|times|post|herald|official)\b/i;
const ATTRIBUTION_PATTERN = /\b(according to|reported by|confirmed by|statement|announced|officials said)\b/i;
const BREAKING_PREFIX_PATTERN = /^\s*(breaking|urgent|alert)\b/i;

export function classifyNewsCandidate(input: NewsClassifierInput): NewsClassification {
    const title = (input.title || '').trim();
    const excerpt = (input.excerpt || '').trim();
    const bodyText = (input.bodyText || '').trim();
    const text = `${title} ${excerpt} ${bodyText}`.toLowerCase();

    const matchedKeywords = NEWS_KEYWORD_WEIGHTS
        .filter((entry) => text.includes(entry.keyword))
        .map((entry) => entry.keyword);

    const keywordScore = NEWS_KEYWORD_WEIGHTS
        .filter((entry) => matchedKeywords.includes(entry.keyword))
        .reduce((sum, entry) => sum + entry.weight, 0);

    const hasBreakingPrefix = BREAKING_PREFIX_PATTERN.test(title);
    const sourceLooksNews = NEWS_SOURCE_PATTERN.test(input.sourceName || '');
    const hasAttribution = ATTRIBUTION_PATTERN.test(`${excerpt} ${bodyText}`);
    const verifiedSource = Boolean(input.sourceVerified);

    const recencyHours = calculateRecencyHours(input.publishedAt);

    let score = keywordScore;
    if (hasBreakingPrefix) score += 10;
    if (verifiedSource) score += 8;
    if (sourceLooksNews) score += 6;
    if (hasAttribution) score += 5;
    if (recencyHours !== null) {
        if (recencyHours <= 24) score += 4;
        else if (recencyHours <= 72) score += 2;
    }
    if (typeof input.priorSignalScore === 'number' && input.priorSignalScore > 0) {
        score += Math.min(10, input.priorSignalScore);
    }

    score = Math.max(0, Math.min(100, score));

    const confidence: NewsConfidence = score >= 40 ? 'high' : score >= 24 ? 'medium' : 'low';
    const likelyNews = score >= 24;

    const categoryHints = deriveCategoryHints(matchedKeywords);

    return {
        version: 'v1',
        likelyNews,
        score,
        confidence,
        categoryHints,
        matchedKeywords,
        signals: {
            hasBreakingPrefix,
            verifiedSource,
            sourceLooksNews,
            hasAttribution,
            recencyHours,
        },
    };
}

function calculateRecencyHours(publishedAt?: Date | null): number | null {
    if (!(publishedAt instanceof Date) || Number.isNaN(publishedAt.getTime())) {
        return null;
    }
    const diffMs = Date.now() - publishedAt.getTime();
    return Math.max(0, Math.round(diffMs / (1000 * 60 * 60)));
}

function deriveCategoryHints(matchedKeywords: string[]): string[] {
    const categorySet = new Set<string>();
    for (const keyword of matchedKeywords) {
        const match = NEWS_KEYWORD_WEIGHTS.find((entry) => entry.keyword === keyword);
        if (match) {
            categorySet.add(match.category);
        }
    }
    return Array.from(categorySet).slice(0, 3);
}

export const newsClassifierService = {
    classifyNewsCandidate,
};
