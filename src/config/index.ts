/**
 * Configuration module - loads and validates environment variables
 */

interface Config {
    // Required
    cmsBaseUrl: string;
    cmsServiceToken: string;
    redisUrl: string;

    // Storage (S3-compatible)
    storageEndpoint: string;
    storageBucket: string;
    storageAccessKey: string;
    storageSecretKey: string;
    storagePublicUrl: string;
    storageRegion: string;

    // AI Services
    whisperApiUrl: string;

    // Media Processing
    mediaTempDir: string;

    // Optional
    sourceAllowlistPath: string | null;
    workerConcurrency: number;
    queueNames: string[];
    logLevel: string;
    metricsPort: number;

    // YouTube API
    youtubeApiKey: string | null;
    youtubeQuotaLimit: number;

    // Reddit OAuth
    redditClientId: string | null;
    redditClientSecret: string | null;
    redditUsername: string | null;
    redditPassword: string | null;

    // Twitter API
    twitterBearerToken: string | null;
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

        // Storage
        storageEndpoint: getRequiredEnv('STORAGE_ENDPOINT'),
        storageBucket: getRequiredEnv('STORAGE_BUCKET'),
        storageAccessKey: getOptionalEnv('STORAGE_ACCESS_KEY', 'minioadmin'),
        storageSecretKey: getOptionalEnv('STORAGE_SECRET_KEY', 'minioadmin'),
        storagePublicUrl: getOptionalEnv('STORAGE_PUBLIC_URL', 'http://localhost:9000'),
        storageRegion: getOptionalEnv('STORAGE_REGION', 'us-east-1'),

        // AI Services
        whisperApiUrl: getOptionalEnv('WHISPER_API_URL', 'http://whisper:9000'),

        // Media Processing
        mediaTempDir: getOptionalEnv('MEDIA_TEMP_DIR', '/tmp/turfa-media'),

        // Optional
        sourceAllowlistPath: process.env['SOURCE_ALLOWLIST_PATH'] || null,
        workerConcurrency: parseInt(getOptionalEnv('WORKER_CONCURRENCY', '5'), 10),
        queueNames: getOptionalEnv('QUEUE_NAMES', 'fetch,normalize,media,ai').split(','),
        logLevel: getOptionalEnv('LOG_LEVEL', 'info'),
        metricsPort: parseInt(getOptionalEnv('METRICS_PORT', '3001'), 10),

        // YouTube
        youtubeApiKey: process.env['YOUTUBE_API_KEY'] || null,
        youtubeQuotaLimit: parseInt(getOptionalEnv('YOUTUBE_QUOTA_LIMIT', '10000'), 10),

        // Reddit
        redditClientId: process.env['REDDIT_CLIENT_ID'] || null,
        redditClientSecret: process.env['REDDIT_CLIENT_SECRET'] || null,
        redditUsername: process.env['REDDIT_USERNAME'] || null,
        redditPassword: process.env['REDDIT_PASSWORD'] || null,

        // Twitter
        twitterBearerToken: process.env['TWITTER_BEARER_TOKEN'] || null,
    };
}

// Export singleton config
export const config = loadConfig();
export type { Config };
