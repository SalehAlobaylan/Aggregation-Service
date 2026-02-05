# Wahb — Aggregation Service Implementation Plan

**Version:** 1.0  
**Date:** January 25, 2026  
**Status:** Ready for Engineering Review  
**Author:** System Architect

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Data Flow & Integration Points](#3-data-flow--integration-points)
4. [Performance Optimization](#4-performance-optimization)
5. [Fault Tolerance & Resilience](#5-fault-tolerance--resilience)
6. [API Strategy](#6-api-strategy)
7. [Implementation Roadmap](#7-implementation-roadmap)
8. [Required Clarifications](#8-required-clarifications)
9. [Appendices](#9-appendices)

---

## 1. Executive Summary

### 1.1 Service Purpose

The Aggregation Service is the **asynchronous content ingestion and processing pipeline** for the Wahb platform. It is a **worker-first system** that:

- Ingests content from external sources (RSS, YouTube, Podcasts, X/Twitter, Reddit, manual uploads)
- Processes media (download, transcode to MP4)
- Generates transcripts via Whisper
- Generates 384-dimension vector embeddings
- Writes results back to the CMS via internal APIs

### 1.2 Critical Constraints

| Constraint                 | Description                                                                 |
| -------------------------- | --------------------------------------------------------------------------- |
| **No User-Facing Traffic** | Must never serve user-facing API traffic                                    |
| **MP4 Required**           | For You feed requires MP4-ready URLs; audio must be converted upstream      |
| **384-dim Embeddings**     | Must use pgvector-compatible 384-dimension vectors (e.g., all-MiniLM-L6-v2) |
| **CMS Write-Back**         | All persistence via CMS internal APIs; no direct database writes            |

### 1.3 System Position

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Wahb Platform                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ┌─────────────────┐      ┌─────────────────┐      ┌───────────────┐  │
│   │  Platform       │      │    CMS/Feed     │      │   Web App     │  │
│   │  Console        │─────▶│    Service      │◀─────│   (Next.js)   │  │
│   │  (Admin UI)     │      │    (Go)         │      │               │  │
│   └────────┬────────┘      └────────▲────────┘      └───────────────┘  │
│            │                        │                                   │
│            │ Trigger                │ Write-back                        │
│            │ Ingestion              │ via APIs                          │
│            ▼                        │                                   │
│   ┌─────────────────────────────────┴───────────────────────────────┐  │
│   │                    AGGREGATION SERVICE                           │  │
│   │                    (Node.js Worker Fleet)                        │  │
│   │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │  │
│   │  │  Fetch   │─▶│ Normalize│─▶│  Media   │─▶│ Transcript/Embed │ │  │
│   │  │  Worker  │  │  Worker  │  │  Worker  │  │     Worker       │ │  │
│   │  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘ │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                           │                                             │
│                           ▼                                             │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │           Object Storage (Supabase Storage / S3)                 │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. System Architecture

### 2.1 Technology Stack

| Component     | Technology            | Purpose                                        |
| ------------- | --------------------- | ---------------------------------------------- |
| Runtime       | Node.js LTS           | Worker execution environment                   |
| Framework     | Fastify               | Minimal internal endpoints (/health, /metrics) |
| Queue         | BullMQ + Redis        | Job queue management                           |
| Media         | FFmpeg + yt-dlp       | Download and transcode                         |
| Transcription | Whisper               | Audio/video transcript generation              |
| Embeddings    | all-MiniLM-L6-v2      | 384-dimension vector generation                |
| Storage       | Supabase Storage / S3 | Media artifact storage                         |

### 2.2 Worker Architecture

The service operates as a **fleet of specialized workers**, each handling a specific pipeline stage:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         BullMQ Queue System                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌──────────┐ │
│  │ fetch-queue │    │normalize-q  │    │ media-queue │    │ ai-queue │ │
│  │             │    │             │    │             │    │          │ │
│  │ • RSS Poll  │    │ • Schema    │    │ • Download  │    │• Whisper │ │
│  │ • YT API    │    │   mapping   │    │ • FFmpeg    │    │• Embed   │ │
│  │ • Scrape    │    │ • Dedupe    │    │ • Upload    │    │          │ │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └────┬─────┘ │
│         │                  │                  │                 │       │
│         ▼                  ▼                  ▼                 ▼       │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Worker Process Pool                          │   │
│  │   (Horizontally scalable across multiple containers/pods)       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Service Boundaries

**Aggregation Service MUST:**

- Fetch/scrape external sources (RSS, YouTube, X/Twitter, Reddit)
- Convert audio to MP4 using FFmpeg
- Generate transcripts for audio/video content
- Generate 384-dimension vector embeddings
- Upload artifacts to object storage
- Write back to CMS via internal APIs

**Aggregation Service MUST NOT:**

- Serve user-facing API traffic
- Assemble feeds or run ranking logic
- Perform pgvector similarity queries
- Issue or verify JWTs

---

## 3. Data Flow & Integration Points

### 3.1 Fan-Out Pattern: Source Ingestion

Content sources fan out to multiple specialized workers based on source type:

```
                    ┌──────────────────┐
                    │  Ingestion       │
                    │  Trigger         │
                    │  (Platform       │
                    │   Console)       │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  Source Router   │
                    │  (content_source │
                    │   type dispatch) │
                    └────────┬─────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  RSS/Article  │   │ YouTube/Video │   │    Social     │
│    Worker     │   │    Worker     │   │    Worker     │
│               │   │               │   │ (X, Reddit)   │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        └───────────────────┴───────────────────┘
                            │
                   ┌────────▼────────┐
                   │ Normalize Queue │
                   └─────────────────┘
```

### 3.2 Fan-In Pattern: Content Aggregation

All source-specific outputs converge through normalization:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Raw Content (per source)                      │
├─────────────────────────────────────────────────────────────────┤
│  RSS Item    │  YouTube Video  │  Tweet    │  Reddit Post       │
│  { title,    │  { snippet,     │  { text,  │  { title,          │
│    link,     │    videoId,     │    author,│    selftext,       │
│    pubDate } │    thumbnail }  │    media }│    score }         │
└──────┬───────┴────────┬────────┴─────┬─────┴────────┬───────────┘
       │                │              │              │
       └────────────────┴──────────────┴──────────────┘
                               │
                      ┌────────▼────────┐
                      │   Normalizer    │
                      │  (Schema Map)   │
                      └────────┬────────┘
                               │
                      ┌────────▼────────┐
                      │  ContentItem    │
                      │  (Canonical)    │
                      └─────────────────┘
```

### 3.3 Integration Points

#### 3.3.1 CMS Internal APIs (Downstream)

| Endpoint                                 | Method | Purpose                                             |
| ---------------------------------------- | ------ | --------------------------------------------------- |
| `/internal/content-items`                | POST   | Create new content item                             |
| `/internal/content-items/:id`            | PUT    | Update existing content item                        |
| `/internal/content-items/:id/status`     | PATCH  | Update status (PENDING → PROCESSING → READY/FAILED) |
| `/internal/content-items/:id/artifacts`  | PATCH  | Attach media_url, thumbnail_url, duration_sec       |
| `/internal/transcripts`                  | POST   | Create transcript record                            |
| `/internal/content-items/:id/transcript` | PATCH  | Link transcript to content item                     |

#### 3.3.2 External Source APIs (Upstream)

| Source    | Integration Method       | Rate Considerations        |
| --------- | ------------------------ | -------------------------- |
| RSS Feeds | HTTP polling             | Respect cache headers      |
| YouTube   | Data API v3              | Quota: 10,000 units/day    |
| X/Twitter | API or approved scraping | Rate limits apply          |
| Reddit    | API                      | OAuth required, 60 req/min |
| Podcasts  | RSS/iTunes Search API    | Standard HTTP              |

#### 3.3.3 Object Storage

| Operation | Target               | Purpose                        |
| --------- | -------------------- | ------------------------------ |
| Upload    | `media/` prefix      | Processed MP4 files            |
| Upload    | `thumbnails/` prefix | Generated/extracted thumbnails |
| Upload    | `originals/` prefix  | Source media preservation      |

### 3.4 Data Contracts

#### ContentItem (CMS Alignment)

```typescript
interface ContentItem {
  // Identity
  id: string; // UUID, assigned by CMS
  idempotency_key: string; // canonical_url OR hash(title + published_at)

  // Classification
  type: "ARTICLE" | "VIDEO" | "TWEET" | "COMMENT" | "PODCAST";
  source: "RSS" | "PODCAST" | "YOUTUBE" | "UPLOAD" | "MANUAL";
  status: "PENDING" | "PROCESSING" | "READY" | "FAILED" | "ARCHIVED";

  // Content
  title: string;
  body_text: string | null;
  excerpt: string | null;

  // Attribution
  author: string | null;
  source_name: string;
  source_feed_url: string | null;

  // Media
  media_url: string | null; // MP4 URL for For You
  thumbnail_url: string | null;
  original_url: string; // Source URL
  duration_sec: number | null;

  // AI/Discovery
  topic_tags: string[];
  embedding: number[]; // 384-dimension vector
  metadata: Record<string, any>; // Source-specific data

  // Timestamps
  published_at: Date;
  created_at: Date;
  updated_at: Date;
}
```

#### Transcript

```typescript
interface Transcript {
  id: string;
  content_item_id: string;
  full_text: string; // Required
  summary: string | null; // Optional
  word_timestamps: WordTimestamp[] | null; // Optional
  language: string;
  created_at: Date;
}
```

---

## 4. Performance Optimization

### 4.1 Caching Strategy

#### 4.1.1 Redis Cache Layers

| Cache Layer       | Key Pattern                   | TTL      | Purpose                      |
| ----------------- | ----------------------------- | -------- | ---------------------------- |
| Source Metadata   | `source:{id}:meta`            | 5 min    | Avoid repeated CMS lookups   |
| Deduplication     | `dedup:{idempotency_key}`     | 24 hours | Prevent duplicate processing |
| Rate Limit Tokens | `ratelimit:{source}:{window}` | 1 min    | Track API quota usage        |
| Job Results       | `job:{id}:result`             | 1 hour   | Store intermediate results   |

#### 4.1.2 Implementation

```typescript
// Redis caching configuration
const cacheConfig = {
  sourceMetadata: {
    prefix: "source:",
    ttl: 300, // 5 minutes
    strategy: "cache-aside",
  },
  deduplication: {
    prefix: "dedup:",
    ttl: 86400, // 24 hours
    strategy: "write-through",
  },
  rateLimiting: {
    prefix: "ratelimit:",
    ttl: 60, // 1 minute sliding window
    strategy: "token-bucket",
  },
};
```

### 4.2 Pagination & Batch Processing

#### 4.2.1 Feed Polling Pagination

| Source  | Pagination Method                 | Batch Size        |
| ------- | --------------------------------- | ----------------- |
| RSS     | `<link rel="next">` or item count | 50 items/poll     |
| YouTube | `pageToken`                       | 50 videos/request |
| Reddit  | `after` cursor                    | 100 posts/request |

#### 4.2.2 Queue Batch Processing

```typescript
// BullMQ batch processing configuration
const queueConfig = {
  fetchQueue: {
    concurrency: 10, // Parallel fetch jobs
    limiter: {
      max: 100,
      duration: 60000, // 100 jobs per minute
    },
  },
  mediaQueue: {
    concurrency: 3, // FFmpeg is CPU-intensive
    limiter: {
      max: 10,
      duration: 60000,
    },
  },
  aiQueue: {
    concurrency: 5, // Whisper + embeddings
    limiter: {
      max: 20,
      duration: 60000,
    },
  },
};
```

### 4.3 Latency Targets

| Operation                        | Target Latency | P99 Ceiling |
| -------------------------------- | -------------- | ----------- |
| RSS fetch + normalize            | < 2s           | 5s          |
| Article scrape + normalize       | < 5s           | 15s         |
| Video download (5 min)           | < 60s          | 120s        |
| FFmpeg transcode (5 min video)   | < 90s          | 180s        |
| Whisper transcript (5 min audio) | < 120s         | 240s        |
| Embedding generation             | < 500ms        | 1s          |
| CMS write-back                   | < 200ms        | 500ms       |

### 4.4 Throughput Optimization

#### 4.4.1 Horizontal Scaling

```yaml
# Worker scaling configuration
scaling:
  fetch_workers:
    min: 2
    max: 10
    metric: queue_depth
    threshold: 100 jobs

  media_workers:
    min: 1
    max: 5
    metric: cpu_utilization
    threshold: 70%

  ai_workers:
    min: 1
    max: 3
    metric: gpu_utilization # If GPU available
    threshold: 80%
```

---

## 5. Fault Tolerance & Resilience

### 5.1 Circuit Breaker Pattern

Implement circuit breakers for all external dependencies:

```typescript
interface CircuitBreakerConfig {
  // Per-dependency configuration
  cms: {
    failureThreshold: 5; // Failures before opening
    resetTimeout: 30000; // 30s before half-open
    halfOpenRequests: 3; // Test requests in half-open
  };
  youtube: {
    failureThreshold: 3;
    resetTimeout: 60000;
    halfOpenRequests: 1;
  };
  storage: {
    failureThreshold: 5;
    resetTimeout: 15000;
    halfOpenRequests: 2;
  };
}
```

#### 5.1.1 Circuit States

```
┌─────────┐     Failure        ┌─────────┐
│ CLOSED  │────threshold──────▶│  OPEN   │
│         │    exceeded        │         │
└────┬────┘                    └────┬────┘
     │                              │
     │ Success                      │ Reset timeout
     │                              │ expires
     │                              ▼
     │                        ┌───────────┐
     │◀───────Success─────────│ HALF-OPEN │
     │                        │           │
     └────────────────────────┴───────────┘
              Failure triggers
              return to OPEN
```

### 5.2 Retry Strategy

| Failure Type     | Retry Strategy | Max Attempts | Backoff                       |
| ---------------- | -------------- | ------------ | ----------------------------- |
| Network timeout  | Exponential    | 3            | 1s, 2s, 4s                    |
| Rate limit (429) | Fixed delay    | 5            | Wait for `Retry-After` header |
| CMS 5xx          | Exponential    | 5            | 2s, 4s, 8s, 16s, 32s          |
| FFmpeg failure   | No retry       | 1            | N/A (log for manual review)   |
| Storage upload   | Exponential    | 3            | 1s, 2s, 4s                    |

### 5.3 Partial Data Delivery

When upstream dependencies fail, the service should deliver partial results:

#### 5.3.1 Degradation Matrix

| Stage Failure        | Behavior                             | Final Status                            |
| -------------------- | ------------------------------------ | --------------------------------------- |
| Fetch fails          | Skip item, log error                 | No record created                       |
| Normalize fails      | Skip item, log error                 | No record created                       |
| Media download fails | Create record without media          | READY (if ARTICLE) or FAILED (if VIDEO) |
| Transcript fails     | Create record without transcript     | READY (transcript optional)             |
| Embedding fails      | Create record without embedding      | READY (embedding optional for v1)       |
| CMS write-back fails | Retry with backoff, then dead-letter | PENDING (stuck)                         |

#### 5.3.2 Dead Letter Queue (DLQ)

```typescript
// DLQ configuration for unrecoverable failures
const dlqConfig = {
  queueName: "aggregation-dlq",
  retention: "7d", // Keep failed jobs for 7 days
  alertThreshold: 100, // Alert when > 100 jobs in DLQ
  processingStrategy: "manual", // Require human intervention
};
```

### 5.4 Health Checks

#### 5.4.1 Liveness Probe

```typescript
// GET /health
interface LivenessResponse {
  status: "healthy" | "unhealthy";
  timestamp: string;
}
```

#### 5.4.2 Readiness Probe

```typescript
// GET /ready
interface ReadinessResponse {
  status: "ready" | "not_ready";
  dependencies: {
    redis: "connected" | "disconnected";
    cms: "reachable" | "unreachable";
    storage: "reachable" | "unreachable";
  };
}
```

### 5.5 Observability

#### 5.5.1 Metrics (Prometheus-compatible)

| Metric                             | Type      | Labels                 |
| ---------------------------------- | --------- | ---------------------- |
| `aggregation_jobs_total`           | Counter   | `queue`, `status`      |
| `aggregation_job_duration_seconds` | Histogram | `queue`, `source_type` |
| `aggregation_queue_depth`          | Gauge     | `queue`                |
| `aggregation_circuit_state`        | Gauge     | `dependency`, `state`  |
| `aggregation_retry_count`          | Counter   | `queue`, `attempt`     |
| `aggregation_dlq_size`             | Gauge     | -                      |

#### 5.5.2 Structured Logging

```typescript
// Log format
interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  service: "aggregation-service";
  job_id: string;
  source_id?: string;
  content_item_id?: string;
  stage: "fetch" | "normalize" | "media" | "transcript" | "embedding";
  message: string;
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
  duration_ms?: number;
}
```

---

## 6. API Strategy

### 6.1 Internal Endpoints

The Aggregation Service exposes **minimal internal endpoints** (not user-facing):

| Endpoint                    | Method | Purpose                                |
| --------------------------- | ------ | -------------------------------------- |
| `/health`                   | GET    | Liveness check                         |
| `/ready`                    | GET    | Readiness check with dependency status |
| `/metrics`                  | GET    | Prometheus metrics                     |
| `/admin/jobs/:id`           | GET    | Job status inspection (optional)       |
| `/admin/queues/:name/stats` | GET    | Queue statistics (optional)            |

### 6.2 CMS Internal API Payloads

#### 6.2.1 Create Content Item

```typescript
// POST /internal/content-items
interface CreateContentItemRequest {
  idempotency_key: string;
  type: ContentType;
  source: SourceType;
  status: "PENDING";

  title: string;
  body_text?: string;
  excerpt?: string;

  author?: string;
  source_name: string;
  source_feed_url?: string;
  original_url: string;

  published_at: string; // ISO 8601
  metadata?: Record<string, any>;
}

// Response
interface CreateContentItemResponse {
  id: string; // UUID assigned by CMS
  status: "PENDING";
  created_at: string;
}
```

#### 6.2.2 Update Artifacts

```typescript
// PATCH /internal/content-items/:id/artifacts
interface UpdateArtifactsRequest {
  media_url?: string;
  thumbnail_url?: string;
  duration_sec?: number;
}
```

#### 6.2.3 Update Status

```typescript
// PATCH /internal/content-items/:id/status
interface UpdateStatusRequest {
  status: "PROCESSING" | "READY" | "FAILED";
  error_message?: string; // Required if FAILED
}
```

#### 6.2.4 Create Transcript

```typescript
// POST /internal/transcripts
interface CreateTranscriptRequest {
  content_item_id: string;
  full_text: string;
  summary?: string;
  word_timestamps?: WordTimestamp[];
  language: string;
}
```

#### 6.2.5 Update Embedding

```typescript
// PATCH /internal/content-items/:id/embedding
interface UpdateEmbeddingRequest {
  embedding: number[]; // 384-dimension vector
  topic_tags?: string[];
}
```

### 6.3 Service-to-Service Authentication

```typescript
// All CMS internal API requests include:
headers: {
  'Authorization': `Bearer ${CMS_SERVICE_TOKEN}`,
  'X-Service-Name': 'aggregation-service',
  'X-Request-ID': uuid()
}
```

---

## 7. Implementation Roadmap

### Phase Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Implementation Timeline                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Phase 1          Phase 2           Phase 3          Phase 4            │
│  Foundation       Core Pipeline     AI & Media       Production         │
│  (2 weeks)        (3 weeks)         (3 weeks)        (2 weeks)          │
│                                                                         │
│  ┌─────────┐      ┌─────────┐       ┌─────────┐      ┌─────────┐       │
│  │ Project │      │ Fetch   │       │ FFmpeg  │      │ Scaling │       │
│  │ Setup   │─────▶│ Workers │──────▶│ Whisper │─────▶│ Hardening│       │
│  │ Queues  │      │ Normalize│      │ Embed   │      │ Deploy  │       │
│  └─────────┘      └─────────┘       └─────────┘      └─────────┘       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### Phase 1: Foundation & Infrastructure (Weeks 1-2)

#### 1.1 Project Setup

| Task                                       | Priority | Effort |
| ------------------------------------------ | -------- | ------ |
| Initialize Node.js project with TypeScript | P0       | 2h     |
| Configure Fastify for internal endpoints   | P0       | 4h     |
| Set up BullMQ with Redis connection        | P0       | 4h     |
| Implement `/health` and `/ready` endpoints | P0       | 2h     |
| Docker + docker-compose configuration      | P0       | 4h     |
| Environment variable configuration         | P0       | 2h     |

#### 1.2 Queue Infrastructure

| Task                                                   | Priority | Effort |
| ------------------------------------------------------ | -------- | ------ |
| Define queue schemas (fetch, normalize, media, ai)     | P0       | 4h     |
| Implement base worker class with retry logic           | P0       | 8h     |
| Set up job event handlers (completed, failed, stalled) | P0       | 4h     |
| Implement dead-letter queue handling                   | P1       | 4h     |
| Add Prometheus metrics integration                     | P1       | 4h     |

#### 1.3 CMS Integration Layer

| Task                                           | Priority | Effort |
| ---------------------------------------------- | -------- | ------ |
| Create CMS API client with authentication      | P0       | 4h     |
| Implement circuit breaker for CMS calls        | P0       | 4h     |
| Define TypeScript interfaces for CMS contracts | P0       | 2h     |
| Add request logging and tracing                | P1       | 2h     |

**Phase 1 Deliverables:**

- [ ] Running Fastify service with health endpoints
- [ ] BullMQ queues operational with Redis
- [ ] CMS API client with circuit breaker
- [ ] Docker-compose for local development
- [ ] Basic metrics and logging

---

### Phase 2: Core Pipeline - Fetch & Normalize (Weeks 3-5)

#### 2.1 RSS/Article Pipeline

| Task                               | Priority | Effort |
| ---------------------------------- | -------- | ------ |
| RSS feed parser implementation     | P0       | 8h     |
| Per-domain allowlist configuration | P0       | 4h     |
| Full-article scraper (readability) | P0       | 12h    |
| HTML-to-text/markdown converter    | P0       | 4h     |
| ARTICLE ContentItem normalizer     | P0       | 4h     |

#### 2.2 YouTube Pipeline

| Task                            | Priority | Effort |
| ------------------------------- | -------- | ------ |
| YouTube Data API v3 integration | P0       | 8h     |
| Channel/playlist polling logic  | P0       | 4h     |
| Video metadata extraction       | P0       | 4h     |
| VIDEO ContentItem normalizer    | P0       | 4h     |
| API quota management            | P1       | 4h     |

#### 2.3 Podcast Pipeline

| Task                           | Priority | Effort |
| ------------------------------ | -------- | ------ |
| Podcast RSS parser             | P0       | 4h     |
| iTunes Search API integration  | P1       | 4h     |
| Episode metadata extraction    | P0       | 2h     |
| PODCAST ContentItem normalizer | P0       | 4h     |

#### 2.4 Social Pipeline

| Task                                  | Priority | Effort |
| ------------------------------------- | -------- | ------ |
| X/Twitter API or scraping integration | P1       | 12h    |
| Reddit API integration                | P1       | 8h     |
| Engagement filtering logic            | P1       | 4h     |
| TWEET/COMMENT ContentItem normalizer  | P1       | 4h     |

#### 2.5 Deduplication & Idempotency

| Task                                  | Priority | Effort |
| ------------------------------------- | -------- | ------ |
| Idempotency key generation (URL hash) | P0       | 4h     |
| Redis-based deduplication cache       | P0       | 4h     |
| Upsert logic for CMS write-back       | P0       | 4h     |

**Phase 2 Deliverables:**

- [ ] RSS/Article ingestion working end-to-end
- [ ] YouTube video metadata ingestion
- [ ] Podcast episode ingestion
- [ ] Social content ingestion (X, Reddit)
- [ ] Deduplication preventing duplicates
- [ ] All content types normalized to ContentItem schema

---

### Phase 3: AI & Media Processing (Weeks 6-8)

#### 3.1 Media Download & Processing

| Task                                          | Priority | Effort |
| --------------------------------------------- | -------- | ------ |
| yt-dlp integration for video download         | P0       | 8h     |
| yt-dlp integration for audio download         | P0       | 4h     |
| FFmpeg MP4 transcoding pipeline               | P0       | 12h    |
| Thumbnail extraction/generation               | P0       | 4h     |
| Audio-to-MP4 conversion (For You requirement) | P0       | 8h     |

#### 3.2 Object Storage Integration

| Task                                   | Priority | Effort |
| -------------------------------------- | -------- | ------ |
| Supabase Storage client implementation | P0       | 4h     |
| S3-compatible fallback support         | P1       | 4h     |
| Upload with retry logic                | P0       | 4h     |
| CDN URL generation                     | P0       | 2h     |

#### 3.3 Transcript Generation

| Task                               | Priority | Effort |
| ---------------------------------- | -------- | ------ |
| Whisper integration (local or API) | P0       | 12h    |
| Audio extraction from video        | P0       | 4h     |
| Transcript text storage via CMS    | P0       | 4h     |
| Word-level timestamps (optional)   | P2       | 8h     |
| Language detection                 | P1       | 4h     |

#### 3.4 Embedding Generation

| Task                                            | Priority | Effort |
| ----------------------------------------------- | -------- | ------ |
| all-MiniLM-L6-v2 model integration              | P0       | 8h     |
| Text chunking strategy (title + excerpt + body) | P0       | 4h     |
| 384-dimension vector generation                 | P0       | 4h     |
| Embedding write-back to CMS                     | P0       | 2h     |

**Phase 3 Deliverables:**

- [ ] Video download and MP4 transcoding
- [ ] Audio-to-MP4 conversion for podcasts
- [ ] Media uploaded to object storage
- [ ] Whisper transcripts generated
- [ ] 384-dim embeddings computed and stored
- [ ] Full pipeline: fetch → normalize → media → transcript → embed → READY

---

### Phase 4: Production Hardening (Weeks 9-10)

#### 4.1 Resilience & Scaling

| Task                                        | Priority | Effort |
| ------------------------------------------- | -------- | ------ |
| Circuit breaker tuning for all dependencies | P0       | 8h     |
| Rate limiter implementation per source      | P0       | 8h     |
| Worker auto-scaling configuration           | P1       | 8h     |
| Memory and CPU profiling                    | P1       | 4h     |
| Load testing (target: 1000 items/hour)      | P0       | 8h     |

#### 4.2 Monitoring & Alerting

| Task                                          | Priority | Effort |
| --------------------------------------------- | -------- | ------ |
| Prometheus metrics finalization               | P0       | 4h     |
| Grafana dashboard creation                    | P1       | 4h     |
| Alert rules (DLQ size, circuit open, latency) | P0       | 4h     |
| Structured logging audit                      | P0       | 2h     |

#### 4.3 Deployment

| Task                                 | Priority | Effort |
| ------------------------------------ | -------- | ------ |
| Production Dockerfile optimization   | P0       | 4h     |
| Kubernetes manifests (if applicable) | P1       | 8h     |
| CI/CD pipeline setup                 | P0       | 8h     |
| Secrets management (env vars)        | P0       | 2h     |
| Runbook documentation                | P1       | 4h     |

#### 4.4 Integration Testing

| Task                                            | Priority | Effort |
| ----------------------------------------------- | -------- | ------ |
| End-to-end pipeline tests                       | P0       | 8h     |
| CMS API contract tests                          | P0       | 4h     |
| Failure scenario tests (circuit breaker, retry) | P0       | 4h     |
| Performance regression tests                    | P1       | 4h     |

**Phase 4 Deliverables:**

- [ ] Production-ready Docker images
- [ ] Monitoring dashboards and alerts
- [ ] Load-tested to 1000 items/hour
- [ ] CI/CD pipeline operational
- [ ] Comprehensive test coverage
- [ ] Operational runbook

---

## 8. Required Clarifications & Suggested Solutions

The following items are **not specified** in the provided documentation. Each item includes a **suggested solution** that can be implemented unless stakeholders specify otherwise.

### 8.1 Infrastructure & Deployment

| Item                            | Question                                                              | Impact                                      | Suggested Solution                                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Kubernetes vs. Docker Swarm** | What is the target orchestration platform?                            | Affects scaling configuration and manifests | **Use Kubernetes (K8s)** — Industry standard with better ecosystem support, HPA for auto-scaling, and native support for job queues. Provide both Docker Compose (dev) and K8s manifests (prod). |
| **GPU availability**            | Is GPU available for Whisper? If not, CPU-only Whisper will be slower | Affects transcription latency targets       | **Plan for CPU-only initially** — Use Whisper `base` model on CPU with async processing. Queue design absorbs latency. Add GPU support as optional enhancement in Phase 4 if available.          |
| **Storage region/provider**     | Supabase Storage vs. AWS S3 vs. other?                                | Affects client implementation and CDN setup | **Use Supabase Storage as primary** (per context docs) with S3-compatible API. Implement storage abstraction layer to allow future migration to AWS S3 if needed.                                |

### 8.2 CMS Internal APIs

| Item                     | Question                                                               | Impact                                | Suggested Solution                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API endpoint paths**   | Exact paths for CMS internal APIs (e.g., `/internal/*` vs. `/admin/*`) | Affects API client implementation     | **Use `/internal/*` prefix** — Separates service-to-service APIs from admin APIs (`/admin/*` is reserved for Platform Console). Proposed paths: `/internal/content-items`, `/internal/transcripts`. |
| **Service token format** | JWT or simple bearer token? Token rotation policy?                     | Affects authentication implementation | **Use simple bearer token (not JWT)** — Service tokens don't need claims verification. Store in env var `CMS_SERVICE_TOKEN`. Implement 90-day rotation policy with overlap period.                  |
| **Batch upsert support** | Can CMS handle batch creates/updates?                                  | Affects throughput optimization       | **Implement single-item API first** — Design for batch support (`POST /internal/content-items/batch`) as Phase 4 optimization. Use parallel requests (max 10 concurrent) as interim solution.       |

### 8.3 Source-Specific

| Item                   | Question                                                    | Impact                          | Suggested Solution                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **YouTube API quota**  | What is the allocated quota? Are we using OAuth or API key? | Affects polling frequency       | **Assume 10,000 units/day default quota** — Use API key (not OAuth) for public data. Implement quota tracking with Redis counter. Poll channels every 15 min, playlists every 30 min. Reserve 20% quota buffer. |
| **X/Twitter access**   | API tier (Basic, Pro, Enterprise) or scraping approach?     | Affects implementation approach | **Use approved scraping initially** — Twitter API pricing is prohibitive for v1. Implement Puppeteer-based scraper with rate limiting (100 req/hour). Design interface to swap to API when budget allows.       |
| **Scraping allowlist** | Initial list of approved domains for full-article scraping? | Affects RSS pipeline scope      | **Start with major news domains** — Initial allowlist: `reuters.com`, `apnews.com`, `bbc.com`, `techcrunch.com`, `theverge.com`, `arstechnica.com`. Store in JSON config, expandable via Platform Console.      |

### 8.4 AI/ML

| Item                        | Question                                 | Impact                                | Suggested Solution                                                                                                                                                                           |
| --------------------------- | ---------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Whisper model size**      | tiny, base, small, medium, or large?     | Affects accuracy vs. latency tradeoff | **Use `base` model** — Best balance of accuracy (WER ~10%) and speed for CPU. ~1GB memory footprint. Transcribes 5-min audio in ~60-90s on CPU. Configurable via `WHISPER_MODEL` env var.    |
| **Whisper deployment**      | Self-hosted, OpenAI API, or Replicate?   | Affects cost and implementation       | **Self-hosted via `openai-whisper` Python package** — Zero per-request cost, full control. Run as sidecar container or subprocess. Fall back to OpenAI API for overflow (budget permitting). |
| **Embedding model hosting** | Self-hosted or API (Hugging Face, etc.)? | Affects latency and cost              | **Self-hosted via `@xenova/transformers`** — Run `all-MiniLM-L6-v2` locally in Node.js using ONNX runtime. ~100MB model, <500ms inference. No API costs or rate limits.                      |

### 8.5 Operational

| Item                    | Question                                                                     | Impact                           | Suggested Solution                                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SLA targets**         | What is the expected time from source publish to READY?                      | Affects queue prioritization     | **Target: 15 minutes for articles, 30 minutes for media** — Articles (no media processing) should be fast. Video/podcast includes download + transcode + transcript. Implement priority queues: `high` (manual uploads), `normal` (scheduled). |
| **Manual upload flow**  | How does Platform Console trigger manual uploads? Direct API or file upload? | Affects endpoint design          | **Two-step flow via CMS** — Console uploads file to storage via CMS `/admin/uploads` endpoint, receives `storage_path`. Console then calls CMS `/admin/content-sources/:id/ingest` with `storage_path`. CMS enqueues job to Aggregation.       |
| **Alerting thresholds** | DLQ size, latency P99, error rate thresholds for alerts?                     | Affects monitoring configuration | **Proposed thresholds:** DLQ > 50 items (warning), > 200 (critical). P99 latency > 2x target (warning), > 5x (critical). Error rate > 5% (warning), > 15% (critical). Circuit breaker open > 5 min (critical).                                 |

### 8.6 Summary of Suggested Defaults

```yaml
# Suggested configuration defaults (can be overridden)
infrastructure:
  orchestration: kubernetes
  gpu_required: false
  storage_provider: supabase

cms_integration:
  api_prefix: /internal
  token_type: bearer
  batch_support: phase_4

sources:
  youtube_quota: 10000_units_per_day
  twitter_method: scraping
  scrape_allowlist:
    - reuters.com
    - apnews.com
    - bbc.com
    - techcrunch.com
    - theverge.com
    - arstechnica.com

ai_ml:
  whisper_model: base
  whisper_deployment: self_hosted
  embedding_model: all-MiniLM-L6-v2
  embedding_deployment: self_hosted_onnx

operations:
  sla_article_minutes: 15
  sla_media_minutes: 30
  manual_upload: cms_mediated
  alert_dlq_warning: 50
  alert_dlq_critical: 200
  alert_error_rate_warning: 0.05
  alert_error_rate_critical: 0.15
```

---

## 9. Appendices

### Appendix A: Environment Variables

```bash
# Required
CMS_BASE_URL=https://cms.wahb.app/internal
CMS_SERVICE_TOKEN=<service-token>
REDIS_URL=redis://localhost:6379
STORAGE_BASE_URL=https://storage.supabase.co
STORAGE_BUCKET=wahb-media

# Optional
SOURCE_ALLOWLIST_PATH=/config/allowlist.json
WORKER_CONCURRENCY=5
QUEUE_NAMES=fetch,normalize,media,ai
LOG_LEVEL=info
METRICS_PORT=9090

# AI/ML
WHISPER_MODEL=base
EMBEDDING_MODEL=all-MiniLM-L6-v2
```

### Appendix B: Docker Compose (Development)

```yaml
version: "3.8"

services:
  aggregation:
    build: .
    environment:
      - CMS_BASE_URL=http://cms:3000/internal
      - CMS_SERVICE_TOKEN=dev-token
      - REDIS_URL=redis://redis:6379
      - STORAGE_BASE_URL=http://minio:9000
      - STORAGE_BUCKET=wahb-media
    depends_on:
      - redis
      - minio
    ports:
      - "3001:3001" # Health/metrics
    volumes:
      - ./config:/config:ro

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=minioadmin
      - MINIO_ROOT_PASSWORD=minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio-data:/data

volumes:
  redis-data:
  minio-data:
```

### Appendix C: Queue Job Schemas

```typescript
// Fetch Job
interface FetchJob {
  source_id: string;
  source_type: "RSS" | "YOUTUBE" | "PODCAST" | "TWITTER" | "REDDIT";
  config: SourceConfig;
  triggered_by: "schedule" | "manual";
  triggered_at: string;
}

// Normalize Job
interface NormalizeJob {
  source_id: string;
  source_type: SourceType;
  raw_items: RawItem[];
  fetch_job_id: string;
}

// Media Job
interface MediaJob {
  content_item_id: string;
  content_type: ContentType;
  source_url: string;
  operations: ("download" | "transcode" | "thumbnail")[];
}

// AI Job
interface AIJob {
  content_item_id: string;
  content_type: ContentType;
  operations: ("transcript" | "embedding")[];
  text_content: {
    title: string;
    excerpt?: string;
    body_text?: string;
  };
  media_path?: string; // For transcript generation
}
```

### Appendix D: Pipeline Stage State Machine

```
                              ┌─────────────┐
                              │   PENDING   │
                              │  (created)  │
                              └──────┬──────┘
                                     │
                         ┌───────────┴───────────┐
                         │                       │
                         ▼                       ▼
                  ┌─────────────┐         ┌───────────┐
                  │ PROCESSING  │         │  FAILED   │
                  │   (fetch)   │────────▶│  (fetch)  │
                  └──────┬──────┘         └───────────┘
                         │
                         ▼
                  ┌─────────────┐         ┌───────────┐
                  │ PROCESSING  │         │  FAILED   │
                  │ (normalize) │────────▶│(normalize)│
                  └──────┬──────┘         └───────────┘
                         │
                         ▼
                  ┌─────────────┐         ┌───────────┐
                  │ PROCESSING  │         │  FAILED   │
                  │   (media)   │────────▶│  (media)  │
                  └──────┬──────┘         └───────────┘
                         │
                         ▼
                  ┌─────────────┐         ┌───────────┐
                  │ PROCESSING  │         │  FAILED   │
                  │(transcript) │────────▶│(transcript│
                  └──────┬──────┘         └───────────┘
                         │
                         ▼
                  ┌─────────────┐         ┌───────────┐
                  │ PROCESSING  │         │  FAILED   │
                  │ (embedding) │────────▶│(embedding)│
                  └──────┬──────┘         └───────────┘
                         │
                         ▼
                  ┌─────────────┐
                  │    READY    │
                  │ (complete)  │
                  └─────────────┘
```

---

## Document History

| Version | Date       | Author           | Changes                     |
| ------- | ---------- | ---------------- | --------------------------- |
| 1.0     | 2026-01-25 | System Architect | Initial implementation plan |

---

_This document is ready for engineering review. All technical decisions are grounded in the provided context documentation. Items requiring clarification have been explicitly identified in Section 8._
