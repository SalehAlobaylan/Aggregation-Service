/**
 * Configuration module with Zod schema validation
 * Fail-fast with actionable error messages
 */
import { z } from 'zod';

// Custom validators
const urlSchema = z.string().url('Must be a valid URL');
const portSchema = z.coerce.number().int().min(1).max(65535);
const positiveIntSchema = z.coerce.number().int().positive();

// Configuration schema
const configSchema = z.object({
    // Required - Core
    cmsBaseUrl: urlSchema.describe('CMS internal API base URL'),
    cmsServiceToken: z.string().min(1, 'CMS service token is required'),
    redisUrl: z.string().min(1, 'Redis URL is required'),

    // Required - Storage (S3-compatible)
    storageEndpoint: urlSchema.describe('S3-compatible storage endpoint'),
    storageBucket: z.string().min(1, 'Storage bucket name is required'),
    storageAccessKey: z.string().default('minioadmin'),
    storageSecretKey: z.string().default('minioadmin'),
    storagePublicUrl: urlSchema.default('http://localhost:9000'),
    storageRegion: z.string().default('us-east-1'),

    // AI Services
    whisperApiUrl: urlSchema.default('http://whisper:9000'),

    // Media Processing
    mediaTempDir: z.string().default('/tmp/turfa-media'),

    // Worker Configuration
    workerConcurrency: positiveIntSchema.default(5),
    queueNames: z.string().default('fetch,normalize,media,ai').transform(s => s.split(',')),

    // Logging & Metrics
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    metricsPort: portSchema.default(3001),

    // Circuit Breaker Tuning
    cbFailureThreshold: positiveIntSchema.default(5),
    cbResetTimeoutMs: positiveIntSchema.default(30000),
    cbHalfOpenRequests: positiveIntSchema.default(3),

    // Rate Limiter
    rateLimitWindowMs: positiveIntSchema.default(60000),
    rateLimitMaxRequests: positiveIntSchema.default(100),

    // Optional - Source Allowlist
    sourceAllowlistPath: z.string().nullable().default(null),

    // Optional - YouTube API
    youtubeApiKey: z.string().nullable().default(null),
    youtubeQuotaLimit: positiveIntSchema.default(10000),

    // Optional - Reddit OAuth
    redditClientId: z.string().nullable().default(null),
    redditClientSecret: z.string().nullable().default(null),
    redditUsername: z.string().nullable().default(null),
    redditPassword: z.string().nullable().default(null),

    // Optional - Twitter API
    twitterBearerToken: z.string().nullable().default(null),

    // Optional - iTunes Search
    enableItunesSearch: z.preprocess(
        (val) => val === undefined ? true : val,
        z.coerce.boolean().default(true)
    ),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Map environment variables to config object
 */
function mapEnvToConfig(): Record<string, unknown> {
    return {
        cmsBaseUrl: process.env.CMS_BASE_URL,
        cmsServiceToken: process.env.CMS_SERVICE_TOKEN,
        redisUrl: process.env.REDIS_URL,

        storageEndpoint: process.env.STORAGE_ENDPOINT,
        storageBucket: process.env.STORAGE_BUCKET,
        storageAccessKey: process.env.STORAGE_ACCESS_KEY,
        storageSecretKey: process.env.STORAGE_SECRET_KEY,
        storagePublicUrl: process.env.STORAGE_PUBLIC_URL,
        storageRegion: process.env.STORAGE_REGION,

        whisperApiUrl: process.env.WHISPER_API_URL,
        mediaTempDir: process.env.MEDIA_TEMP_DIR,

        workerConcurrency: process.env.WORKER_CONCURRENCY,
        queueNames: process.env.QUEUE_NAMES,
        logLevel: process.env.LOG_LEVEL,
        metricsPort: process.env.METRICS_PORT,

        cbFailureThreshold: process.env.CB_FAILURE_THRESHOLD,
        cbResetTimeoutMs: process.env.CB_RESET_TIMEOUT_MS,
        cbHalfOpenRequests: process.env.CB_HALF_OPEN_REQUESTS,

        rateLimitWindowMs: process.env.RATE_LIMIT_WINDOW_MS,
        rateLimitMaxRequests: process.env.RATE_LIMIT_MAX_REQUESTS,

        sourceAllowlistPath: process.env.SOURCE_ALLOWLIST_PATH || null,

        youtubeApiKey: process.env.YOUTUBE_API_KEY || null,
        youtubeQuotaLimit: process.env.YOUTUBE_QUOTA_LIMIT,

        redditClientId: process.env.REDDIT_CLIENT_ID || null,
        redditClientSecret: process.env.REDDIT_CLIENT_SECRET || null,
        redditUsername: process.env.REDDIT_USERNAME || null,
        redditPassword: process.env.REDDIT_PASSWORD || null,

        twitterBearerToken: process.env.TWITTER_BEARER_TOKEN || null,

        enableItunesSearch: process.env.ENABLE_ITUNES_SEARCH,
    };
}

/**
 * Load and validate configuration
 * Fails fast with clear error messages
 */
function loadConfig(): Config {
    const rawConfig = mapEnvToConfig();

    const result = configSchema.safeParse(rawConfig);

    if (!result.success) {
        const errors = result.error.issues.map(issue => {
            const path = issue.path.join('.');
            const envVar = pathToEnvVar(path);
            return `  - ${envVar}: ${issue.message}`;
        });

        console.error('\n❌ Configuration Error\n');
        console.error('The following environment variables are missing or invalid:\n');
        console.error(errors.join('\n'));
        console.error('\nSee .env.example for required configuration.\n');

        process.exit(1);
    }

    return result.data;
}

/**
 * Convert config path to environment variable name
 */
function pathToEnvVar(path: string): string {
    return path
        .replace(/([A-Z])/g, '_$1')
        .toUpperCase()
        .replace(/^_/, '');
}

/**
 * Redact sensitive values for logging
 */
export function getRedactedConfig(cfg: Config): Record<string, unknown> {
    return {
        cmsBaseUrl: cfg.cmsBaseUrl,
        cmsServiceToken: '[REDACTED]',
        redisUrl: cfg.redisUrl.replace(/\/\/.*@/, '//<redacted>@'),
        storageEndpoint: cfg.storageEndpoint,
        storageBucket: cfg.storageBucket,
        storageAccessKey: '[REDACTED]',
        storageSecretKey: '[REDACTED]',
        storagePublicUrl: cfg.storagePublicUrl,
        whisperApiUrl: cfg.whisperApiUrl,
        workerConcurrency: cfg.workerConcurrency,
        logLevel: cfg.logLevel,
        metricsPort: cfg.metricsPort,
        cbFailureThreshold: cfg.cbFailureThreshold,
        cbResetTimeoutMs: cfg.cbResetTimeoutMs,
        youtubeApiKey: cfg.youtubeApiKey ? '[CONFIGURED]' : null,
        redditClientId: cfg.redditClientId ? '[CONFIGURED]' : null,
        twitterBearerToken: cfg.twitterBearerToken ? '[CONFIGURED]' : null,
    };
}

// Export singleton config
export const config = loadConfig();
