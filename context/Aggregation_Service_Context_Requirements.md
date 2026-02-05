# Wahb — Aggregation Service Context & Requirements (Node.js Worker Fleet)

This document describes the Aggregation Service in the Wahb platform. It is a worker-first system that ingests content from external sources, processes media, generates transcripts and embeddings, and writes results back via CMS internal APIs. It must never serve user-facing API traffic.

## 1) Service purpose & system location

The Aggregation Service is the asynchronous pipeline for Wahb. It handles ingest, processing, and enrichment for all external sources, and persists outputs so the Go CMS/Feed Service can serve the app. It is the only component allowed to scrape content or run FFmpeg conversions.

System boundaries:

- Aggregation Service (this service): fetch/scrape, media processing, transcript generation, embeddings, and write-back.
- CMS/Feed Service: reads from content_items, executes pgvector similarity, and assembles feeds.
- Platform Console: triggers ingestion via CMS admin endpoints and monitors content_items.status.

## 2) Runtime, framework, and execution model

- Runtime: Node.js (LTS) in Docker.
- Framework: Fastify for minimal internal endpoints (/health, /metrics, optional admin hooks). No user-facing API surface.
- Workers: BullMQ-based queue workers, split by pipeline stage.
- Media stack: FFmpeg and yt-dlp for download/transcode.
- Transcription: Whisper-based transcription (text stored in Postgres transcripts table).

## 3) Core responsibilities

- Ingest content from RSS, YouTube, podcast feeds/iTunes search, X/Twitter, Reddit, and manual uploads.
- Normalize into the ContentItem schema used by CMS.
- Produce MP4-ready media for the For You feed (audio must be converted to MP4 upstream).
- Generate transcripts for audio/video content and store in transcripts.
- Generate embeddings (384-dimension vectors) and write to content_items.embedding.
- Upload media artifacts to object storage (Supabase Storage or S3-compatible).
- Update content_items.status via CMS internal APIs (PENDING → PROCESSING → READY/FAILED).

## 4) Source coverage (v1)

All sources are in-scope for v1, with an initial focus on:

- Manual upload (CMS admin-triggered).
- RSS news feeds and web article scraping.
- Podcast RSS / iTunes search.

Additional sources also included in v1:

- YouTube Data API v3.
- X/Twitter and Reddit (API or approved scraping).

Scraping policy:

- Full-article scraping is allowed only for domains on a per-domain allowlist.
- The allowlist is required for HTML extraction and readability rules.

## 5) Data contracts (alignment with CMS)

The Aggregation Service writes data compatible with the CMS platform models:

ContentItem

- Type: ARTICLE, VIDEO, TWEET, COMMENT, PODCAST.
- Status: PENDING, PROCESSING, READY, FAILED, ARCHIVED.
- Core fields: title, body_text, excerpt, author, source_name, source_feed_url.
- Media fields: media_url, thumbnail_url, original_url, duration_sec.
- AI fields: topic_tags, embedding (vector384), metadata JSONB.
- Timestamps: published_at, created_at, updated_at.

Transcript

- Stored in transcripts table with content_item_id.
- Full text is required; summary and word_timestamps are optional.

## 6) Ingestion pipelines

### 6.1 RSS / Web Article Pipeline

Steps:

1. Poll RSS feed for new items.
2. Parse item (title, link, published_at).
3. If excerpt-only, scrape full article content from allowlisted domains and clean HTML to text/markdown.
4. Normalize into ContentItem (ARTICLE) and set status to READY when complete.

### 6.2 Video / Podcast Pipeline (YouTube + Podcast RSS)

Steps:

1. Poll channel/playlist/feed for new media.
2. Download with yt-dlp to obtain metadata and media streams.
3. Transcode with FFmpeg. MP4 is required for For You; HLS may be generated as an additional artifact if desired.
4. Generate transcript using Whisper if not provided.
5. Upload artifacts and persist ContentItem (VIDEO or PODCAST) with media_url, duration_sec, and transcript linkage.

### 6.3 Social Pipeline (X/Twitter, Reddit)

Steps:

1. Fetch recent posts via API or approved scraping.
2. Filter by engagement to reduce noise.
3. If the item is a reply/comment, attempt to capture parent context in metadata.
4. Persist ContentItem as TWEET or COMMENT.

## 7) Pipeline stages and checkpoints

The pipeline is modeled as stage jobs to enable retries and partial progress.

Stages:

- Fetch: acquire raw source data.
- Normalize: map to ContentItem schema and dedupe keys.
- Media: download/transcode and upload artifacts.
- Transcript: generate and store transcript text.
- Embeddings: generate 384-dimension vector and write to content_items.

Checkpointing behavior:

- Status updated to PROCESSING when a job starts.
- Each stage updates CMS with its output fields.
- Status set to READY only when required artifacts for the content type exist.

## 8) Idempotency and deduplication

Idempotency keys:

- Primary: canonical URL when available.
- Fallback: hash(title + published_at) when no URL or external ID is available.

Repeated runs must be safe: upserts should not create duplicates when the idempotency key matches.

## 9) Embeddings

- Use a lightweight open-source embedding model that produces 384-dimension vectors (e.g., all-MiniLM-L6-v2).
- Embeddings are computed from title + excerpt + body_text and stored in content_items.embedding.

## 10) Storage artifacts

Artifacts produced per content type:

- Original media file (if source provides it).
- Processed media (MP4 required for For You content).
- Thumbnail images.
- Transcript text in transcripts table.
- Fully populated ContentItem record via CMS API.

## 11) Operational requirements

- Queue-based workers with retries for transient failures (rate limits, network, scraping failures).
- Horizontal scalability across worker processes.
- Best-effort pipeline: prioritize successful ingestion with minimal blocking.
- Observability: logs per job with source identifiers and content_item_id.

## 12) CMS integration (required)

Aggregation writes to the platform via CMS internal/admin APIs (no direct DB writes):

- Content item upsert (create/update by idempotency key).
- Status updates (PENDING → PROCESSING → READY/FAILED).
- Artifact updates (media_url, thumbnail_url, original_url, duration_sec).
- Transcript creation and linkage (transcripts table + transcript_id reference).

## 13) Environment variables (aggregation service)

Required

- CMS_BASE_URL: CMS internal/admin API base.
- CMS_SERVICE_TOKEN: service-to-service authentication token.
- REDIS_URL: queue backend.
- STORAGE_BASE_URL / STORAGE_BUCKET: object storage target.

Optional

- SOURCE_ALLOWLIST_PATH or inline allowlist configuration for scraping.
- WORKER_CONCURRENCY and QUEUE_NAMES for tuning.

## 14) Non-goals

- Serving user-facing API traffic.
- Performing feed assembly or pgvector similarity queries.
- Acting as the admin UI (Platform Console owns that surface).
