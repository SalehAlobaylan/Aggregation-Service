/**
 * Test Media Job Script
 * Enqueues a test media job for verification
 */
import { getRedisConnection, closeRedisConnection } from '../queues/redis.js';
import { initializeQueues, closeQueues, getQueue, QUEUE_NAMES } from '../queues/index.js';
import { logger } from '../observability/logger.js';
import { v4 as uuid } from 'uuid';

interface TestMediaArgs {
    url: string;
    type: 'VIDEO' | 'PODCAST';
    contentItemId?: string;
}

function parseArgs(): TestMediaArgs {
    const args = process.argv.slice(2);
    const result: TestMediaArgs = {
        url: '',
        type: 'VIDEO',
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--url' && args[i + 1]) {
            result.url = args[i + 1];
            i++;
        } else if (args[i] === '--type' && args[i + 1]) {
            result.type = args[i + 1].toUpperCase() as 'VIDEO' | 'PODCAST';
            i++;
        } else if (args[i] === '--id' && args[i + 1]) {
            result.contentItemId = args[i + 1];
            i++;
        }
    }

    return result;
}

async function testMediaJob(): Promise<void> {
    const args = parseArgs();

    if (!args.url) {
        console.log(`
Usage: npm run test:media -- --url <URL> --type <VIDEO|PODCAST> [--id <contentItemId>]

Examples:
  npm run test:media -- --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --type VIDEO
  npm run test:media -- --url "https://example.com/podcast.mp3" --type PODCAST
`);
        process.exit(1);
    }

    const contentItemId = args.contentItemId || uuid();

    logger.info('Starting test media job', {
        url: args.url,
        type: args.type,
        contentItemId,
    });

    // Initialize Redis and queues
    getRedisConnection();
    initializeQueues();

    const mediaQueue = getQueue(QUEUE_NAMES.MEDIA);
    if (!mediaQueue) {
        logger.error('Media queue not initialized');
        process.exit(1);
    }

    try {
        const job = await mediaQueue.add(
            `test-media-${contentItemId}`,
            {
                contentItemId,
                contentType: args.type,
                sourceUrl: args.url,
                operations: ['download', 'transcode', 'thumbnail'],
            },
            {
                priority: 1,
            }
        );

        logger.info('Test media job enqueued', {
            jobId: job.id,
            contentItemId,
            url: args.url,
            type: args.type,
        });

        console.log(`
✅ Media job enqueued successfully!

Job ID: ${job.id}
Content Item ID: ${contentItemId}
URL: ${args.url}
Type: ${args.type}

Monitor progress with:
  docker compose logs -f aggregation | grep "${contentItemId}"

Check MinIO console:
  http://localhost:9001 (minioadmin/minioadmin)
  Look for: turfa-media/content/${contentItemId}/
`);

        // Wait a moment for the job to be persisted
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Check queue status
        const counts = await mediaQueue.getJobCounts();
        console.log('Queue status:', counts);

    } finally {
        await closeQueues();
        await closeRedisConnection();
    }
}

// Run the script
testMediaJob()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Test failed:', error);
        process.exit(1);
    });
