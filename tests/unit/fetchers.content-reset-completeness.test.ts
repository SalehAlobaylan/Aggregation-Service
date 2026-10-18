import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceConfig } from '../../src/fetchers/types.js';

const mocks = vi.hoisted(() => ({ parse: vi.fn(), rate: vi.fn(), safeFetch: vi.fn(), redis: vi.fn() }));
vi.mock('rss-parser', () => ({ default: class { parseString = mocks.parse; } }));
vi.mock('../../src/services/rate-limiter.js', () => ({ rateLimiter: { consumeRateLimit: mocks.rate } }));
vi.mock('../../src/utils/safe-fetch.js', () => ({ safeFetch: mocks.safeFetch }));
vi.mock('../../src/queues/redis.js', () => ({ getRedisConnection: mocks.redis }));
vi.mock('../../src/observability/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const config: SourceConfig = { id: 'source', type: 'PODCAST', name: 'Test', url: 'https://example.test/feed', enabled: true, pollIntervalMs: 300000, settings: { max_results: 100 } };
function feed(count: number) {
  return { title: 'Test', items: Array.from({ length: count }, (_, i) => ({ guid: String(i), title: 'Episode', enclosure: { url: `https://example.test/${i}.mp3` }, isoDate: '2026-09-15T00:00:00Z' })) };
}

describe('provider observation completeness for reset replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockResolvedValue({ allowed: true });
    mocks.safeFetch.mockResolvedValue({ ok: true, body: '<rss />' });
  });

  it('marks a locally capped Podcast listing incomplete instead of claiming exhaustion', async () => {
    const { podcastFetcher } = await import('../../src/fetchers/podcast.fetcher.js');
    mocks.parse.mockResolvedValue(feed(101));
    const result = await podcastFetcher.fetch(config);
    expect(result.items).toHaveLength(100);
    expect(result.metadata.truncated).toBe(true);
    mocks.parse.mockResolvedValue(feed(100));
    expect((await podcastFetcher.fetch(config)).metadata.truncated).toBe(false);
  });


  it('replays the exact reserved Podcast identity before applying its one-item cap', async () => {
    const { podcastFetcher } = await import('../../src/fetchers/podcast.fetcher.js');
    mocks.parse.mockResolvedValue(feed(101));
    const result = await podcastFetcher.fetch({ ...config, settings: { max_results: 1, deferred_observation_map: { '100': '00000000-0000-4000-8000-000000000001' } } });
    expect(result.items.map((item) => item.externalId)).toEqual(['100']);
    expect(result.metadata.truncated).toBe(false);
  });

  it('does not count a locally rate-limited Podcast as a provider request', async () => {
    const { podcastFetcher } = await import('../../src/fetchers/podcast.fetcher.js');
    const { withSourceProviderIO } = await import('../../src/services/source-provider-io.js');
    mocks.rate.mockResolvedValue({ allowed: false });
    const started = vi.fn();
    await expect(withSourceProviderIO(1, started, () => {}, () => podcastFetcher.fetch(config))).rejects.toThrow('rate limit');
    expect(started).not.toHaveBeenCalled();
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('marks local Reddit rate limiting as unavailable without provider or Redis calls', async () => {
    const { redditFetcher } = await import('../../src/fetchers/reddit.fetcher.js');
    mocks.rate.mockResolvedValue({ allowed: false });
    const result = await redditFetcher.fetch({ ...config, type: 'REDDIT', settings: { subreddit: 'news' } });
    expect(result.items).toEqual([]);
    expect(result.metadata).toMatchObject({ unavailable: true, reason: 'rate_limited' });
    expect(mocks.redis).not.toHaveBeenCalled();
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });
});
