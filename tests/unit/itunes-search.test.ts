/**
 * iTunes Search Service Tests
 * Tests the iTunes Search API client with mocked HTTP
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/queues/redis.js', () => {
    const mockRedis = {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue('OK'),
        zremrangebyscore: vi.fn().mockResolvedValue(0),
        zcard: vi.fn().mockResolvedValue(0),
        zadd: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
        zrange: vi.fn().mockResolvedValue([]),
    };
    return {
        getRedisConnection: () => mockRedis,
        __mockRedis: mockRedis,
    };
});

vi.mock('../../src/observability/logger.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('../../src/observability/metrics.js', () => ({
    rateLimitHits: { inc: vi.fn() },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('iTunes Search Service', () => {
    let itunesSearch: typeof import('../../src/services/itunes-search.js').itunesSearch;
    let mockRedis: any;

    beforeEach(async () => {
        vi.resetModules();

        // Set up env to enable iTunes Search
        process.env.ENABLE_ITUNES_SEARCH = 'true';

        const redisModule = await import('../../src/queues/redis.js');
        mockRedis = (redisModule as any).__mockRedis;
        mockRedis.get.mockResolvedValue(null);

        const searchModule = await import('../../src/services/itunes-search.js');
        itunesSearch = searchModule.itunesSearch;

        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('searchPodcasts', () => {
        it('should return cached results if available', async () => {
            const cachedResults = [
                { collectionId: 123, collectionName: 'Cached Podcast', feedUrl: 'https://example.com/feed.xml' },
            ];
            mockRedis.get.mockResolvedValue(JSON.stringify(cachedResults));

            const result = await itunesSearch.searchPodcasts('test');

            expect(result.cached).toBe(true);
            expect(result.results).toEqual(cachedResults);
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should fetch from iTunes API when not cached', async () => {
            mockRedis.get.mockResolvedValue(null);
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    resultCount: 1,
                    results: [
                        {
                            collectionId: 456,
                            collectionName: 'New Podcast',
                            artistName: 'Artist',
                            feedUrl: 'https://example.com/new.xml',
                            genres: ['Technology'],
                            releaseDate: '2024-01-01',
                            trackCount: 50,
                        },
                    ],
                }),
            });

            const result = await itunesSearch.searchPodcasts('technology');

            expect(result.cached).toBe(false);
            expect(result.results.length).toBe(1);
            expect(result.results[0].feedUrl).toBe('https://example.com/new.xml');
            expect(mockRedis.setex).toHaveBeenCalled();
        });

        it('should filter out results without feedUrl', async () => {
            mockRedis.get.mockResolvedValue(null);
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    results: [
                        { collectionId: 1, collectionName: 'No Feed' },
                        { collectionId: 2, collectionName: 'Has Feed', feedUrl: 'https://example.com/feed.xml' },
                    ],
                }),
            });

            const result = await itunesSearch.searchPodcasts('test');

            expect(result.results.length).toBe(1);
            expect(result.results[0].collectionId).toBe(2);
        });
    });

    describe('isEnabled', () => {
        it('should return true by default', () => {
            expect(itunesSearch.isEnabled()).toBe(true);
        });
    });
});
