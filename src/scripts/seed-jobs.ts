/**
 * Seed Jobs Script
 * Manually triggers initial fetch jobs for testing
 */
import { getRedisConnection, closeRedisConnection } from '../queues/redis.js';
import { initializeQueues, closeQueues, getQueue, QUEUE_NAMES } from '../queues/index.js';
import { logger } from '../observability/logger.js';
import type { FetchJob } from '../queues/schemas.js';

// Sample sources for testing
const SAMPLE_SOURCES = {
    rss: [
        {
            id: 'bbc-news',
            name: 'BBC News',
            url: 'https://feeds.bbci.co.uk/news/rss.xml',
        },
        {
            id: 'techcrunch',
            name: 'TechCrunch',
            url: 'https://techcrunch.com/feed/',
        },
    ],
    youtube: [
        {
            id: 'google-developers',
            name: 'Google Developers',
            channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
        },
    ],
    podcast: [
        {
            id: 'lex-fridman',
            name: 'Lex Fridman Podcast',
            url: 'https://lexfridman.com/feed/podcast/',
        },
    ],
    reddit: [
        {
            id: 'technology',
            name: 'r/technology',
            subreddit: 'technology',
            minScore: 100,
        },
    ],
};

async function seedJobs(): Promise<void> {
    logger.info('Starting seed jobs script...');

    // Initialize Redis and queues
    getRedisConnection();
    initializeQueues();

    const fetchQueue = getQueue(QUEUE_NAMES.FETCH);
    if (!fetchQueue) {
        logger.error('Fetch queue not initialized');
        return;
    }

    const args = process.argv.slice(2);
    const sourceType = args[0]?.toUpperCase() || 'ALL';

    try {
        // Seed RSS sources
        if (sourceType === 'ALL' || sourceType === 'RSS') {
            for (const source of SAMPLE_SOURCES.rss) {
                const job: FetchJob = {
                    sourceId: source.id,
                    sourceType: 'RSS',
                    config: {
                        name: source.name,
                        url: source.url,
                        settings: {},
                    },
                    triggeredBy: 'manual',
                    triggeredAt: new Date().toISOString(),
                };

                await fetchQueue.add(`seed-rss-${source.id}`, job);
                logger.info('Seeded RSS source', { sourceId: source.id, name: source.name });
            }
        }

        // Seed YouTube sources (requires API key)
        if ((sourceType === 'ALL' || sourceType === 'YOUTUBE') && process.env['YOUTUBE_API_KEY']) {
            for (const source of SAMPLE_SOURCES.youtube) {
                const job: FetchJob = {
                    sourceId: source.id,
                    sourceType: 'YOUTUBE',
                    config: {
                        name: source.name,
                        url: source.channelId,
                        settings: { channelId: source.channelId },
                    },
                    triggeredBy: 'manual',
                    triggeredAt: new Date().toISOString(),
                };

                await fetchQueue.add(`seed-youtube-${source.id}`, job);
                logger.info('Seeded YouTube source', { sourceId: source.id, name: source.name });
            }
        }

        // Seed Podcast sources
        if (sourceType === 'ALL' || sourceType === 'PODCAST') {
            for (const source of SAMPLE_SOURCES.podcast) {
                const job: FetchJob = {
                    sourceId: source.id,
                    sourceType: 'PODCAST',
                    config: {
                        name: source.name,
                        url: source.url,
                        settings: {},
                    },
                    triggeredBy: 'manual',
                    triggeredAt: new Date().toISOString(),
                };

                await fetchQueue.add(`seed-podcast-${source.id}`, job);
                logger.info('Seeded Podcast source', { sourceId: source.id, name: source.name });
            }
        }

        // Seed Reddit sources (requires OAuth credentials)
        if ((sourceType === 'ALL' || sourceType === 'REDDIT') && process.env['REDDIT_CLIENT_ID']) {
            for (const source of SAMPLE_SOURCES.reddit) {
                const job: FetchJob = {
                    sourceId: source.id,
                    sourceType: 'REDDIT',
                    config: {
                        name: source.name,
                        url: source.subreddit,
                        settings: {
                            subreddit: source.subreddit,
                            minScore: source.minScore,
                            sortBy: 'hot',
                        },
                    },
                    triggeredBy: 'manual',
                    triggeredAt: new Date().toISOString(),
                };

                await fetchQueue.add(`seed-reddit-${source.id}`, job);
                logger.info('Seeded Reddit source', { sourceId: source.id, name: source.name });
            }
        }

        // Check queue status
        const counts = await fetchQueue.getJobCounts();
        logger.info('Seed complete', {
            waiting: counts.waiting,
            active: counts.active,
        });

    } finally {
        // Cleanup
        await closeQueues();
        await closeRedisConnection();
    }
}

// Run the script
seedJobs()
    .then(() => {
        console.log('Seed jobs completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Seed jobs failed:', error);
        process.exit(1);
    });
