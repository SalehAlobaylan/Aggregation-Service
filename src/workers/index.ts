/**
 * Worker registration and management
 */
import { Worker } from 'bullmq';
import { logger } from '../observability/logger.js';

// Import all workers
import { fetchWorker } from './fetch.worker.js';
import { normalizeWorker } from './normalize.worker.js';
import { mediaWorker } from './media.worker.js';
import { aiWorker } from './ai.worker.js';

// All registered workers
const workers: Worker[] = [
    fetchWorker,
    normalizeWorker,
    mediaWorker,
    aiWorker,
];

/**
 * Get all registered workers
 */
export function getAllWorkers(): Worker[] {
    return workers;
}

/**
 * Start all workers
 */
export function startWorkers(): void {
    logger.info('Starting all workers...');
    // Workers start automatically when created
    // This function is for explicit initialization in the future
}

/**
 * Close all workers gracefully
 */
export async function closeWorkers(): Promise<void> {
    logger.info('Closing all workers...');

    await Promise.all(
        workers.map(async (worker) => {
            try {
                await worker.close();
                logger.info(`Worker closed for queue: ${worker.name}`);
            } catch (error) {
                logger.error(`Error closing worker for queue: ${worker.name}`, error);
            }
        })
    );

    logger.info('All workers closed');
}

// Export individual workers
export { fetchWorker } from './fetch.worker.js';
export { normalizeWorker } from './normalize.worker.js';
export { mediaWorker } from './media.worker.js';
export { aiWorker } from './ai.worker.js';
export { createWorker } from './base-worker.js';
