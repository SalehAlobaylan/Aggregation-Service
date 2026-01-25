# Turfa — LLM Context Requirements (for AI Agents)

This document defines the core rules and system constraints that AI agents must follow when working across the Turfa platform. It consolidates the service boundaries, data contracts, and pipeline expectations from the full context set.

## 1) System definitions

Turfa is a social app with two feeds:

- For You: audio/video cards (full-screen MP4).
- News: editorial slides (1 featured item + 3 related items).

A scroll unit is the atomic unit of content:

- News: a slide (1 featured + 3 related).
- For You: a card (1 MP4).

## 2) Service boundaries (strict rules)

### 2.1 Aggregation Service (Node.js worker fleet)

Do:

- Fetch/scrape external sources (RSS, YouTube, X/Twitter, Reddit).
- Convert audio to MP4 using FFmpeg (required for For You).
- Generate transcripts for audio/video and store in transcripts table.
- Generate vector embeddings (384 dims) and write to content_items.
- Upload artifacts to object storage and write back via CMS internal APIs.

Do not:

- Serve user-facing API traffic.
- Assemble feeds or run ranking logic.

### 2.2 CMS / Feed Service (Go)

Do:

- Read from content_items and serve JSON to the app.
- Compose News slides (1 featured + 3 related) and For You cards.
- Execute vector similarity via pgvector.
- Provide admin endpoints for Console and internal endpoints for Aggregation.

Do not:

- Scrape websites or run FFmpeg conversions.

### 2.3 Platform Console (Admin UI)

Do:

- Operate content_sources and trigger ingestion via CMS /admin/\* endpoints.
- Monitor content_items.status transitions (PENDING → PROCESSING → READY/FAILED).

Do not:

- Talk directly to Aggregation queues in v1.

## 3) Key engineering constraints

- For You must always return MP4-ready URLs.
- News feed must return slides with 1 featured + 3 related items.
- Vector search relies on pgvector with 384-dimension embeddings.
- Polymorphic content model: tweets, articles, and videos live in content_items.

## 4) Data contracts (high-level)

content_items fields required by downstream services:

- type: ARTICLE, VIDEO, TWEET, COMMENT, PODCAST
- status: PENDING, PROCESSING, READY, FAILED, ARCHIVED
- media_url, thumbnail_url, original_url, duration_sec (where applicable)
- title, body_text, excerpt, author, source_name, published_at
- embedding vector(384), topic_tags, metadata JSONB

transcripts:

- content_item_id (UUID) + full_text

content_sources:

- name, type, feed_url, api_config, is_active, fetch_interval_minutes

## 5) Common task routing (agent guidance)

- Add or modify ingestion sources → Aggregation Service.
- Change feed composition or ranking → CMS / Feed Service.
- Update video encoding/transcoding → Aggregation Service.
- Adjust admin workflows or Console UI → Platform Console.
