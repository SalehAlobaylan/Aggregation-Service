/**
 * Configuration module - loads and validates environment variables
 */

interface Config {
    // Required
    cmsBaseUrl: string;
    cmsServiceToken: string;
    redisUrl: string;
    storageBaseUrl: string;
    storageBucket: string;

    // Optional
    sourceAllowlistPath: string | null;
    workerConcurrency: number;
    queueNames: string[];
    logLevel: string;
    metricsPort: number;
}

function getRequiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function getOptionalEnv(name: string, defaultValue: string): string {
    return process.env[name] || defaultValue;
}

function loadConfig(): Config {
    return {
        // Required
        cmsBaseUrl: getRequiredEnv('CMS_BASE_URL'),
        cmsServiceToken: getRequiredEnv('CMS_SERVICE_TOKEN'),
        redisUrl: getRequiredEnv('REDIS_URL'),
        storageBaseUrl: getRequiredEnv('STORAGE_BASE_URL'),
        storageBucket: getRequiredEnv('STORAGE_BUCKET'),

        // Optional
        sourceAllowlistPath: process.env['SOURCE_ALLOWLIST_PATH'] || null,
        workerConcurrency: parseInt(getOptionalEnv('WORKER_CONCURRENCY', '5'), 10),
        queueNames: getOptionalEnv('QUEUE_NAMES', 'fetch,normalize,media,ai').split(','),
        logLevel: getOptionalEnv('LOG_LEVEL', 'info'),
        metricsPort: parseInt(getOptionalEnv('METRICS_PORT', '3001'), 10),
    };
}

// Export singleton config
export const config = loadConfig();
export type { Config };
