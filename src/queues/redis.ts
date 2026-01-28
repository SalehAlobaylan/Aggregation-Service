/**
 * Redis connection for BullMQ
 */
import IORedisModule from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';

// Handle both ESM and CJS exports
const IORedis = (IORedisModule as typeof IORedisModule & { default?: typeof IORedisModule })?.default ?? IORedisModule;

type RedisInstance = InstanceType<typeof IORedis>;

let redisConnection: RedisInstance | null = null;

export function getRedisConnection(): RedisInstance {
    if (!redisConnection) {
        const connection: RedisInstance = new IORedis(config.redisUrl, {
            maxRetriesPerRequest: null, // Required for BullMQ
            enableReadyCheck: false,
        });

        connection.on('connect', () => {
            logger.info('Redis connected');
        });

        connection.on('ready', () => {
            logger.info('Redis ready');
        });

        connection.on('error', (error: Error) => {
            logger.error('Redis error', error);
        });

        connection.on('close', () => {
            logger.warn('Redis connection closed');
        });

        connection.on('reconnecting', () => {
            logger.info('Redis reconnecting');
        });

        redisConnection = connection;
    }

    return redisConnection;
}

export async function isRedisConnected(): Promise<boolean> {
    try {
        if (!redisConnection) return false;
        const result = await redisConnection.ping();
        return result === 'PONG';
    } catch {
        return false;
    }
}

export async function closeRedisConnection(): Promise<void> {
    if (redisConnection) {
        await redisConnection.quit();
        redisConnection = null;
        logger.info('Redis connection closed');
    }
}
