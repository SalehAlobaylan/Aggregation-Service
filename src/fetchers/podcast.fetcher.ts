/**
 * Podcast RSS Fetcher
 * Parses podcast RSS feeds to extract episode metadata
 */
import Parser from 'rss-parser';
import { logger } from '../observability/logger.js';
import { rateLimiter } from '../services/rate-limiter.js';
import type { Fetcher, FetchResult, RawFetchedItem, SourceConfig } from './types.js';

// Standard rss-parser without complex customFields
const parser = new Parser({
    timeout: 20000,
    headers: {
        'User-Agent': 'TurfaBot/1.0 (Podcast Aggregation)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    },
});

/**
 * Parse duration string to seconds
 * Handles formats: HH:MM:SS, MM:SS, seconds
 */
function parseDuration(duration?: string): number | undefined {
    if (!duration) return undefined;

    // Already a number (seconds)
    if (/^\d+$/.test(duration)) {
        return parseInt(duration);
    }

    // HH:MM:SS or MM:SS format
    const parts = duration.split(':').map(p => parseInt(p) || 0);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }

    return undefined;
}

export const podcastFetcher: Fetcher = {
    sourceType: 'PODCAST',

    async fetch(config: SourceConfig, _cursor?: string): Promise<FetchResult> {
        const items: RawFetchedItem[] = [];
        let skipped = 0;
        let errors = 0;

        // Check rate limit
        const rateCheck = await rateLimiter.consumeRateLimit('PODCAST', config.id);
        if (!rateCheck.allowed) {
            logger.warn('Podcast rate limit exceeded', { sourceId: config.id });
            return {
                items: [],
                hasMore: false,
                metadata: { totalFetched: 0, skipped: 0, errors: 0 },
            };
        }

        try {
            logger.info('Fetching podcast feed', { url: config.url, sourceId: config.id });
            const feed = await parser.parseURL(config.url);

            const showName = feed.title || 'Unknown Podcast';
            // Access image from feed - rss-parser includes itunes data in standard fields
            const showImage = (feed as Record<string, unknown>)['itunes:image'] as string | undefined;

            for (const episode of feed.items || []) {
                try {
                    // Podcast episodes must have an enclosure (audio file)
                    if (!episode.enclosure?.url) {
                        skipped++;
                        continue;
                    }

                    // Extract itunes fields from episode (rss-parser includes them)
                    const itunesDuration = (episode as Record<string, unknown>)['itunes:duration'] as string | undefined;
                    const itunesEpisode = (episode as Record<string, unknown>)['itunes:episode'] as string | undefined;
                    const itunesSeason = (episode as Record<string, unknown>)['itunes:season'] as string | undefined;
                    const itunesImage = (episode as Record<string, unknown>)['itunes:image'] as string | undefined;
                    const itunesAuthor = (episode as Record<string, unknown>)['itunes:author'] as string | undefined;
                    const itunesSummary = (episode as Record<string, unknown>)['itunes:summary'] as string | undefined;
                    const itunesExplicit = (episode as Record<string, unknown>)['itunes:explicit'] as string | undefined;

                    const item: RawFetchedItem = {
                        externalId: episode.guid || episode.enclosure.url,
                        sourceType: 'PODCAST',
                        url: episode.link || episode.enclosure.url,
                        title: episode.title || 'Untitled Episode',
                        content: itunesSummary || episode.content || '',
                        excerpt: (episode.contentSnippet || itunesSummary || '').substring(0, 300),
                        author: itunesAuthor || episode.creator,
                        publishedAt: episode.isoDate || episode.pubDate,
                        thumbnailUrl: itunesImage || showImage,
                        duration: parseDuration(itunesDuration),
                        metadata: {
                            showName,
                            showUrl: feed.link,
                            feedUrl: config.url,
                            enclosureUrl: episode.enclosure.url,
                            enclosureType: episode.enclosure.type,
                            enclosureLength: episode.enclosure.length,
                            episodeNumber: itunesEpisode,
                            seasonNumber: itunesSeason,
                            explicit: itunesExplicit,
                            guid: episode.guid,
                        },
                        fetchedAt: new Date().toISOString(),
                    };

                    items.push(item);
                } catch (itemError) {
                    errors++;
                    logger.error('Error processing podcast episode', itemError, {
                        episodeTitle: episode.title,
                        sourceId: config.id,
                    });
                }
            }

            logger.info('Podcast feed fetched', {
                sourceId: config.id,
                showName,
                totalEpisodes: items.length,
                skipped,
                errors,
            });

            return {
                items,
                hasMore: false, // Podcast RSS doesn't have pagination
                metadata: {
                    totalFetched: items.length,
                    skipped,
                    errors,
                },
            };
        } catch (error) {
            logger.error('Failed to fetch podcast feed', error, {
                url: config.url,
                sourceId: config.id,
            });
            throw error;
        }
    },
};
