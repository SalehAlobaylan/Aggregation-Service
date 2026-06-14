/**
 * Configuration module with Zod schema validation
 * Fail-fast with actionable error messages
 */
import 'dotenv/config';
import { z } from 'zod';

// Custom validators
// .trim() first: z.string().url() accepts a value with a stray trailing space
// (the URL parser tolerates it) but stores it un-trimmed, which then yields
// unparseable fetch URLs like "http://host:5050 /v1/embed". Trim defensively.
const urlSchema = z.string().trim().url('Must be a valid URL');
const portSchema = z.coerce.number().int().min(1).max(65535);
const positiveIntSchema = z.coerce.number().int().positive();
const csvListSchema = z.string().transform((value) =>
    value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
);

// Configuration schema
const configSchema = z.object({
    // Required - Core
    cmsBaseUrl: urlSchema.describe('CMS internal API base URL'),
    cmsServiceToken: z.string().min(1, 'CMS service token is required'),
    redisUrl: z.string().min(1, 'Redis URL is required'),
    jwtSecret: z.string().min(1, 'JWT secret is required for admin auth'),
    // Shared secret protecting internal service-to-service routes such as
    // POST /internal/jobs/user-content (called by CMS for user-submitted content).
    // Must match AGGREGATION_SERVICE_TOKEN on the CMS side. Optional at boot
    // so dev stacks without it can still start; the route plugin refuses
    // requests at call-time when this is empty.
    internalServiceToken: z.string().default(''),

    // Required - Storage (S3-compatible) — primary/hot tier
    storageEndpoint: urlSchema.describe('S3-compatible storage endpoint'),
    storageBucket: z.string().min(1, 'Storage bucket name is required'),
    storageAccessKey: z.string().default('minioadmin'),
    storageSecretKey: z.string().default('minioadmin'),
    storagePublicUrl: urlSchema.default('http://localhost:9000'),
    storageRegion: z.string().default('us-east-1'),

    // Optional - Cold tier (any S3-compatible bucket — R2, B2, Wasabi, AWS S3, etc.).
    // When configured, the storage worker can move purge candidates here instead
    // of deleting them outright.
    coldStorageEnabled: z.coerce.boolean().default(false),
    coldStorageEndpoint: z.string().nullable().default(null),
    coldStorageBucket: z.string().nullable().default(null),
    coldStorageAccessKey: z.string().nullable().default(null),
    coldStorageSecretKey: z.string().nullable().default(null),
    coldStoragePublicUrl: z.string().nullable().default(null),
    coldStorageRegion: z.string().default('us-east-1'),

    // Cloudflare R2 Analytics — optional. When set, the op-metrics flush
    // worker also pulls per-bucket Class A/B counts from the GraphQL API
    // hourly. Without this, the Operations panel only shows internal SDK
    // calls (massively understates real Class B at scale).
    cloudflareAccountId:    z.string().nullable().default(null),
    cloudflareApiToken:     z.string().nullable().default(null),
    cloudflareR2BucketName: z.string().nullable().default(null),

    // AI Services — split across two backends:
    //   - Media-Service: audio + image processing (transcribe, image embed)
    //   - Enrichment-Service: text intelligence (text embed, tags, future LLM)
    // Single shared SERVICE_AUTH_TOKEN works for both via start.sh fallbacks.
    enrichmentBaseUrl:      urlSchema.default('http://localhost:5050'),
    enrichmentServiceToken: z.string().default(''),
    mediaBaseUrl:           urlSchema.default('http://localhost:5051'),
    mediaServiceToken:      z.string().default(''),

    // Embedding reconciliation sweep (H2 backstop) — periodically re-enqueues
    // embedding-only AI jobs for READY items still missing a dense embedding.
    reconcileEnabled:    z.coerce.boolean().default(true),
    reconcileIntervalMs: positiveIntSchema.default(300_000), // 5 min
    reconcileBatch:      positiveIntSchema.default(50),

    // Transcription routing — audio longer than this goes through Media's async
    // job queue (avoids HTTP gateway timeouts on long-form). Probed via ffprobe;
    // falls back to a content-type heuristic if the probe fails.
    asyncTranscribeThresholdSec: positiveIntSchema.default(120),

    // Media Processing
    mediaTempDir: z.string().default('/tmp/wahb-media'),

    // Worker Configuration
    workerConcurrency: positiveIntSchema.default(5),
    queueNames: z.string().default('fetch,normalize,media,ai').transform(s => s.split(',')),

    // Job Timeouts & Stall Detection
    mediaJobTimeoutMs: positiveIntSchema.default(1800000),  // 30 min — FFmpeg can be slow
    defaultJobTimeoutMs: positiveIntSchema.default(300000), // 5 min — fetch/normalize/ai
    stalledIntervalMs: positiveIntSchema.default(30000),    // 30s between stall checks
    maxStalledCount: positiveIntSchema.default(1),          // fail job after 1 stall detection

    // Logging & Metrics
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    metricsPort: portSchema.default(5002),

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

    // Optional - Telegram API
    telegramApiId: z.preprocess(
        (val) => (val === undefined || val === null || val === '') ? null : Number(val),
        z.number().int().positive().nullable().default(null)
    ),
    telegramApiHash: z.string().nullable().default(null),
    telegramSessionString: z.string().nullable().default(null),

    // Optional - Reddit OAuth
    redditClientId: z.string().nullable().default(null),
    redditClientSecret: z.string().nullable().default(null),
    redditUsername: z.string().nullable().default(null),
    redditPassword: z.string().nullable().default(null),

    // Optional - Twitter API
    twitterBearerToken: z.string().nullable().default(null),

    // Optional - Tavily web search (source discovery; crawl-only fallback when unset)
    tavilyApiKey: z.string().nullable().default(null),

    // Optional - iTunes Search
    enableItunesSearch: z.preprocess(
        (val) => val === undefined ? true : val,
        z.coerce.boolean().default(true)
    ),

    // Admin Auth + CORS (Platform Console integration)
    adminJwtIssuer: z.string().default('cms-service'),
    adminJwtAudience: z.string().default('platform-console'),
    adminAllowedRoles: csvListSchema.default(['admin', 'manager']),
    platformConsoleOrigins: csvListSchema.default(['http://localhost:3005', 'http://localhost:3000']),
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
        jwtSecret: process.env.JWT_SECRET,
        internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN,

        storageEndpoint: process.env.STORAGE_ENDPOINT,
        storageBucket: process.env.STORAGE_BUCKET,
        storageAccessKey: process.env.STORAGE_ACCESS_KEY,
        storageSecretKey: process.env.STORAGE_SECRET_KEY,
        storagePublicUrl: process.env.STORAGE_PUBLIC_URL,
        storageRegion: process.env.STORAGE_REGION,

        coldStorageEnabled: process.env.COLD_STORAGE_ENABLED,
        coldStorageEndpoint: process.env.COLD_STORAGE_ENDPOINT || null,
        coldStorageBucket: process.env.COLD_STORAGE_BUCKET || null,
        coldStorageAccessKey: process.env.COLD_STORAGE_ACCESS_KEY || null,
        coldStorageSecretKey: process.env.COLD_STORAGE_SECRET_KEY || null,
        coldStoragePublicUrl: process.env.COLD_STORAGE_PUBLIC_URL || null,
        coldStorageRegion: process.env.COLD_STORAGE_REGION,

        cloudflareAccountId:    process.env.CLOUDFLARE_ACCOUNT_ID || null,
        cloudflareApiToken:     process.env.CLOUDFLARE_API_TOKEN || null,
        cloudflareR2BucketName: process.env.CLOUDFLARE_R2_BUCKET_NAME || null,

        enrichmentBaseUrl: process.env.ENRICHMENT_BASE_URL,
        enrichmentServiceToken: process.env.ENRICHMENT_SERVICE_TOKEN,
        mediaBaseUrl: process.env.MEDIA_BASE_URL,
        mediaServiceToken: process.env.MEDIA_SERVICE_TOKEN,
        reconcileEnabled: process.env.RECONCILE_ENABLED,
        reconcileIntervalMs: process.env.RECONCILE_INTERVAL_MS,
        reconcileBatch: process.env.RECONCILE_BATCH,
        asyncTranscribeThresholdSec: process.env.ASYNC_TRANSCRIBE_THRESHOLD_SEC,
        mediaTempDir: process.env.MEDIA_TEMP_DIR,

        workerConcurrency: process.env.WORKER_CONCURRENCY,
        queueNames: process.env.QUEUE_NAMES,
        mediaJobTimeoutMs: process.env.MEDIA_JOB_TIMEOUT_MS,
        defaultJobTimeoutMs: process.env.DEFAULT_JOB_TIMEOUT_MS,
        stalledIntervalMs: process.env.STALLED_INTERVAL_MS,
        maxStalledCount: process.env.MAX_STALLED_COUNT,
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

        telegramApiId: process.env.TELEGRAM_API_ID,
        telegramApiHash: process.env.TELEGRAM_API_HASH || null,
        telegramSessionString: process.env.TELEGRAM_SESSION_STRING || null,

        redditClientId: process.env.REDDIT_CLIENT_ID || null,
        redditClientSecret: process.env.REDDIT_CLIENT_SECRET || null,
        redditUsername: process.env.REDDIT_USERNAME || null,
        redditPassword: process.env.REDDIT_PASSWORD || null,

        twitterBearerToken: process.env.TWITTER_BEARER_TOKEN || null,

        tavilyApiKey: process.env.TAVILY_API_KEY || null,

        enableItunesSearch: process.env.ENABLE_ITUNES_SEARCH,
        adminJwtIssuer: process.env.ADMIN_JWT_ISSUER,
        adminJwtAudience: process.env.ADMIN_JWT_AUDIENCE,
        adminAllowedRoles: process.env.ADMIN_ALLOWED_ROLES,
        platformConsoleOrigins: process.env.PLATFORM_CONSOLE_ORIGINS,
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
        jwtSecret: '[REDACTED]',
        internalServiceToken: '[REDACTED]',
        redisUrl: cfg.redisUrl.replace(/\/\/.*@/, '//<redacted>@'),
        storageEndpoint: cfg.storageEndpoint,
        storageBucket: cfg.storageBucket,
        storageAccessKey: '[REDACTED]',
        storageSecretKey: '[REDACTED]',
        storagePublicUrl: cfg.storagePublicUrl,
        enrichmentBaseUrl: cfg.enrichmentBaseUrl,
        enrichmentServiceToken: cfg.enrichmentServiceToken ? '[REDACTED]' : '',
        mediaBaseUrl: cfg.mediaBaseUrl,
        mediaServiceToken: cfg.mediaServiceToken ? '[REDACTED]' : '',
        workerConcurrency: cfg.workerConcurrency,
        logLevel: cfg.logLevel,
        metricsPort: cfg.metricsPort,
        cbFailureThreshold: cfg.cbFailureThreshold,
        cbResetTimeoutMs: cfg.cbResetTimeoutMs,
        youtubeApiKey: cfg.youtubeApiKey ? '[CONFIGURED]' : null,
        telegramApiId: cfg.telegramApiId ? '[CONFIGURED]' : null,
        telegramApiHash: cfg.telegramApiHash ? '[CONFIGURED]' : null,
        telegramSessionString: cfg.telegramSessionString ? '[CONFIGURED]' : null,
        redditClientId: cfg.redditClientId ? '[CONFIGURED]' : null,
        twitterBearerToken: cfg.twitterBearerToken ? '[CONFIGURED]' : null,
        adminJwtIssuer: cfg.adminJwtIssuer,
        adminJwtAudience: cfg.adminJwtAudience,
        adminAllowedRoles: cfg.adminAllowedRoles,
        platformConsoleOrigins: cfg.platformConsoleOrigins,
    };
}

// Export singleton config
export const config = loadConfig();
