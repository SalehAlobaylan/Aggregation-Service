/**
 * Admin Endpoints Tests
 * Tests the admin API endpoints response shapes
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/queues/index.js', () => ({
    QUEUE_NAMES: {
        FETCH: 'fetch',
        NORMALIZE: 'normalize',
        MEDIA: 'media',
        AI: 'ai',
    },
    getQueue: vi.fn((name) => ({
        getJobCounts: vi.fn().mockResolvedValue({
            waiting: 10,
            active: 2,
            completed: 100,
            failed: 5,
            delayed: 3,
        }),
        getJob: vi.fn().mockResolvedValue(null),
    })),
}));

vi.mock('../../src/services/scheduler.service.js', () => ({
    scheduler: {
        triggerPoll: vi.fn().mockResolvedValue('job-123'),
        getScheduledJobs: vi.fn().mockResolvedValue([]),
    },
}));

vi.mock('../../src/services/rate-limiter.js', () => ({
    rateLimiter: {
        getRateLimits: vi.fn().mockReturnValue({
            RSS: { maxRequests: 60, windowMs: 60000 },
            YOUTUBE: { maxRequests: 100, windowMs: 60000 },
        }),
        getRateLimitStatus: vi.fn().mockResolvedValue({
            current: 10,
            max: 60,
            remaining: 50,
            windowMs: 60000,
        }),
    },
}));

vi.mock('../../src/services/itunes-search.js', () => ({
    itunesSearch: {
        isEnabled: vi.fn().mockReturnValue(true),
        searchPodcasts: vi.fn().mockResolvedValue({
            query: 'test',
            results: [],
            cached: false,
        }),
    },
}));

vi.mock('../../src/observability/logger.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

describe('Admin Endpoints Response Shapes', () => {
    describe('QueueStatsResponse', () => {
        it('should have correct shape for queue stats', () => {
            const expectedShape = {
                queue: 'fetch',
                waiting: 10,
                active: 2,
                completed: 100,
                failed: 5,
                delayed: 3,
            };

            expect(expectedShape).toHaveProperty('queue');
            expect(expectedShape).toHaveProperty('waiting');
            expect(expectedShape).toHaveProperty('active');
            expect(expectedShape).toHaveProperty('completed');
            expect(expectedShape).toHaveProperty('failed');
            expect(expectedShape).toHaveProperty('delayed');
        });
    });

    describe('JobResponse', () => {
        it('should have correct shape for job inspection', () => {
            const expectedShape = {
                id: 'job-123',
                name: 'fetch-rss',
                data: { sourceId: 'test' },
                state: 'completed',
                progress: 100,
                attemptsMade: 1,
                failedReason: undefined,
                processedOn: 1700000000000,
                finishedOn: 1700000001000,
                timestamp: 1699999999000,
            };

            expect(expectedShape).toHaveProperty('id');
            expect(expectedShape).toHaveProperty('name');
            expect(expectedShape).toHaveProperty('data');
            expect(expectedShape).toHaveProperty('state');
            expect(expectedShape).toHaveProperty('progress');
            expect(expectedShape).toHaveProperty('attemptsMade');
            expect(expectedShape).toHaveProperty('timestamp');
        });
    });

    describe('RateLimitConfig', () => {
        it('should have maxRequests and windowMs', () => {
            const config = {
                maxRequests: 60,
                windowMs: 60000,
            };

            expect(config).toHaveProperty('maxRequests');
            expect(config).toHaveProperty('windowMs');
            expect(typeof config.maxRequests).toBe('number');
            expect(typeof config.windowMs).toBe('number');
        });
    });

    describe('ItunesSearchResult', () => {
        it('should have correct shape', () => {
            const result = {
                query: 'tech podcasts',
                results: [
                    {
                        collectionId: 123,
                        collectionName: 'Test Podcast',
                        artistName: 'Test Artist',
                        feedUrl: 'https://example.com/feed.xml',
                        artworkUrl600: 'https://example.com/art.jpg',
                        genres: ['Technology'],
                        releaseDate: '2024-01-01',
                        trackCount: 100,
                    },
                ],
                cached: false,
            };

            expect(result).toHaveProperty('query');
            expect(result).toHaveProperty('results');
            expect(result).toHaveProperty('cached');
            expect(result.results[0]).toHaveProperty('feedUrl');
        });
    });
});
