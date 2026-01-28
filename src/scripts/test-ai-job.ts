/**
 * Test AI Job Script
 * Enqueues a test AI job for verification
 */
import { getRedisConnection, closeRedisConnection } from '../queues/redis.js';
import { initializeQueues, closeQueues, getQueue, QUEUE_NAMES } from '../queues/index.js';
import { logger } from '../observability/logger.js';
import { v4 as uuid } from 'uuid';

interface TestAIArgs {
    contentItemId: string;
    type: 'VIDEO' | 'PODCAST' | 'ARTICLE';
    title: string;
    text?: string;
    mediaPath?: string;
}

function parseArgs(): TestAIArgs {
    const args = process.argv.slice(2);
    const result: TestAIArgs = {
        contentItemId: uuid(),
        type: 'ARTICLE',
        title: 'Test Content',
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--id' && args[i + 1]) {
            result.contentItemId = args[i + 1];
            i++;
        } else if (args[i] === '--type' && args[i + 1]) {
            result.type = args[i + 1].toUpperCase() as 'VIDEO' | 'PODCAST' | 'ARTICLE';
            i++;
        } else if (args[i] === '--title' && args[i + 1]) {
            result.title = args[i + 1];
            i++;
        } else if (args[i] === '--text' && args[i + 1]) {
            result.text = args[i + 1];
            i++;
        } else if (args[i] === '--media' && args[i + 1]) {
            result.mediaPath = args[i + 1];
            i++;
        }
    }

    return result;
}

async function testAIJob(): Promise<void> {
    const args = parseArgs();

    logger.info('Starting test AI job', { ...args });

    // Initialize Redis and queues
    getRedisConnection();
    initializeQueues();

    const aiQueue = getQueue(QUEUE_NAMES.AI);
    if (!aiQueue) {
        logger.error('AI queue not initialized');
        process.exit(1);
    }

    try {
        const operations: ('transcript' | 'embedding')[] = ['embedding'];
        if (args.mediaPath) {
            operations.unshift('transcript');
        }

        const job = await aiQueue.add(
            `test-ai-${args.contentItemId}`,
            {
                contentItemId: args.contentItemId,
                contentType: args.type,
                operations,
                textContent: {
                    title: args.title,
                    bodyText: args.text,
                },
                mediaPath: args.mediaPath,
            },
            {
                priority: 1,
            }
        );

        logger.info('Test AI job enqueued', {
            jobId: job.id,
            contentItemId: args.contentItemId,
            operations,
        });

        console.log(`
✅ AI job enqueued successfully!

Job ID: ${job.id}
Content Item ID: ${args.contentItemId}
Type: ${args.type}
Operations: ${operations.join(', ')}
${args.mediaPath ? `Media Path: ${args.mediaPath}` : ''}

Monitor progress with:
  docker compose logs -f aggregation | grep "${args.contentItemId}"
`);

        // Wait a moment for the job to be persisted
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Check queue status
        const counts = await aiQueue.getJobCounts();
        console.log('Queue status:', counts);

    } finally {
        await closeQueues();
        await closeRedisConnection();
    }
}

// Run the script
testAIJob()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Test failed:', error);
        process.exit(1);
    });
