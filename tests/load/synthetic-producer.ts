/**
 * Synthetic Load Test Producer
 * Produces jobs at a specified rate to test throughput
 *
 * Usage: npx tsx tests/load/synthetic-producer.ts --target 1000
 */
import { getRedisConnection, closeRedisConnection } from '../../src/queues/redis.js';
import { initializeQueues, closeQueues, getQueue, QUEUE_NAMES } from '../../src/queues/index.js';
import { v4 as uuid } from 'uuid';

interface LoadTestConfig {
    targetJobsPerHour: number;
    durationSeconds: number;
    verbose: boolean;
}

interface LoadTestResult {
    totalJobsEnqueued: number;
    targetJobsPerHour: number;
    actualJobsPerHour: number;
    durationSeconds: number;
    avgEnqueueLatencyMs: number;
    errors: number;
}

function parseArgs(): LoadTestConfig {
    const args = process.argv.slice(2);
    const config: LoadTestConfig = {
        targetJobsPerHour: 1000,
        durationSeconds: 60,
        verbose: false,
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--target' && args[i + 1]) {
            config.targetJobsPerHour = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--duration' && args[i + 1]) {
            config.durationSeconds = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--verbose') {
            config.verbose = true;
        }
    }

    return config;
}

async function runLoadTest(config: LoadTestConfig): Promise<LoadTestResult> {
    console.log(`\n🚀 Starting Load Test`);
    console.log(`   Target: ${config.targetJobsPerHour} jobs/hour`);
    console.log(`   Duration: ${config.durationSeconds} seconds\n`);

    // Initialize
    getRedisConnection();
    initializeQueues();

    const fetchQueue = getQueue(QUEUE_NAMES.FETCH);
    const normalizeQueue = getQueue(QUEUE_NAMES.NORMALIZE);
    const aiQueue = getQueue(QUEUE_NAMES.AI);

    if (!fetchQueue || !normalizeQueue || !aiQueue) {
        throw new Error('Failed to initialize queues');
    }

    // Calculate timing
    const jobsPerSecond = config.targetJobsPerHour / 3600;
    const delayBetweenJobsMs = 1000 / jobsPerSecond;

    let totalEnqueued = 0;
    let errors = 0;
    const latencies: number[] = [];

    const startTime = Date.now();
    const endTime = startTime + config.durationSeconds * 1000;

    console.log(`   Delay between jobs: ${delayBetweenJobsMs.toFixed(2)}ms`);
    console.log(`   Jobs/second: ${jobsPerSecond.toFixed(2)}\n`);

    // Progress tracking
    let lastProgressTime = startTime;
    const progressInterval = 5000; // 5 seconds

    while (Date.now() < endTime) {
        const jobStart = Date.now();

        try {
            // Create synthetic jobs for different queues
            const contentItemId = uuid();
            const jobType = totalEnqueued % 3;

            if (jobType === 0) {
                // Fetch job (simulated - no external calls)
                await fetchQueue.add(`load-test-${contentItemId}`, {
                    contentItemId,
                    sourceType: 'RSS',
                    sourceUrl: `https://example.com/feed-${totalEnqueued}.xml`,
                    _synthetic: true,
                });
            } else if (jobType === 1) {
                // Normalize job
                await normalizeQueue.add(`load-test-${contentItemId}`, {
                    contentItemId,
                    contentType: 'ARTICLE',
                    rawContent: `<html><body><h1>Article ${totalEnqueued}</h1><p>Test content for load testing.</p></body></html>`,
                    _synthetic: true,
                });
            } else {
                // AI job (embedding only, no media)
                await aiQueue.add(`load-test-${contentItemId}`, {
                    contentItemId,
                    contentType: 'ARTICLE',
                    operations: ['embedding'],
                    textContent: {
                        title: `Load Test Article ${totalEnqueued}`,
                        bodyText: 'This is synthetic content generated for load testing purposes.',
                    },
                    _synthetic: true,
                });
            }

            totalEnqueued++;
            latencies.push(Date.now() - jobStart);

            // Progress report
            if (Date.now() - lastProgressTime > progressInterval) {
                const elapsed = (Date.now() - startTime) / 1000;
                const currentRate = (totalEnqueued / elapsed) * 3600;
                console.log(`   Progress: ${totalEnqueued} jobs enqueued, ${currentRate.toFixed(0)} jobs/hour rate`);
                lastProgressTime = Date.now();
            }

        } catch (error) {
            errors++;
            if (config.verbose) {
                console.error('   Enqueue error:', error);
            }
        }

        // Calculate sleep time to maintain rate
        const elapsed = Date.now() - jobStart;
        const sleepTime = Math.max(0, delayBetweenJobsMs - elapsed);
        if (sleepTime > 0) {
            await new Promise(resolve => setTimeout(resolve, sleepTime));
        }
    }

    // Calculate results
    const actualDuration = (Date.now() - startTime) / 1000;
    const actualJobsPerHour = (totalEnqueued / actualDuration) * 3600;
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

    const result: LoadTestResult = {
        totalJobsEnqueued: totalEnqueued,
        targetJobsPerHour: config.targetJobsPerHour,
        actualJobsPerHour,
        durationSeconds: actualDuration,
        avgEnqueueLatencyMs: avgLatency,
        errors,
    };

    // Print results
    console.log(`\n📊 Load Test Results`);
    console.log(`   ─────────────────────────────`);
    console.log(`   Duration:       ${result.durationSeconds.toFixed(1)}s`);
    console.log(`   Jobs Enqueued:  ${result.totalJobsEnqueued}`);
    console.log(`   Target Rate:    ${result.targetJobsPerHour} jobs/hour`);
    console.log(`   Actual Rate:    ${result.actualJobsPerHour.toFixed(0)} jobs/hour`);
    console.log(`   Avg Latency:    ${result.avgEnqueueLatencyMs.toFixed(2)}ms`);
    console.log(`   Errors:         ${result.errors}`);
    console.log(`   ─────────────────────────────`);

    const passed = result.actualJobsPerHour >= config.targetJobsPerHour * 0.95;
    console.log(`\n   ${passed ? '✅ PASSED' : '❌ FAILED'}: ${passed ? 'Target rate achieved' : 'Target rate not achieved'}`);

    // Check queue depths
    const fetchCounts = await fetchQueue.getJobCounts();
    const normalizeCounts = await normalizeQueue.getJobCounts();
    const aiCounts = await aiQueue.getJobCounts();

    console.log(`\n📦 Queue Depths After Test`);
    console.log(`   Fetch:     ${fetchCounts.waiting} waiting`);
    console.log(`   Normalize: ${normalizeCounts.waiting} waiting`);
    console.log(`   AI:        ${aiCounts.waiting} waiting`);

    return result;
}

// Main execution
async function main(): Promise<void> {
    const config = parseArgs();

    if (config.targetJobsPerHour <= 0 || config.durationSeconds <= 0) {
        console.log(`
Usage: npx tsx tests/load/synthetic-producer.ts [options]

Options:
  --target <N>     Target jobs per hour (default: 1000)
  --duration <N>   Test duration in seconds (default: 60)
  --verbose        Show detailed errors

Examples:
  npx tsx tests/load/synthetic-producer.ts --target 1000 --duration 60
  npx tsx tests/load/synthetic-producer.ts --target 500 --duration 120 --verbose
`);
        process.exit(1);
    }

    try {
        await runLoadTest(config);
    } finally {
        await closeQueues();
        await closeRedisConnection();
    }
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('Load test failed:', error);
        process.exit(1);
    });
