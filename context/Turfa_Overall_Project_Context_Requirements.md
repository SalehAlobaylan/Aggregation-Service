# Turfa — Overall Project Context & Requirements

This document consolidates the product, system architecture, and service boundaries for Turfa. It incorporates the PRD and the platform/service requirements for the CMS, Aggregation Service, and Platform Console.

## 1) Executive summary

Turfa is a mobile-first social platform that merges an audio-first “For You” feed with a magazine-style “News” feed, consumed via TikTok-style vertical snap scrolling. The product’s core innovation is “dual-mode discovery,” where users switch between immersive audio entertainment and premium journalism in one app.

Core value proposition:

- For consumers: discover podcasts and news without decision fatigue.
- For creators: viral discovery for audio content (podcasts, show clips).
- For publishers: premium, magazine-style presentation for journalism.

## 2) Core feeds & UX constraints

Turfa has two feeds:

1. For You (audio-first)

- Full-screen MP4 cards.
- Audio-only sources must be converted into MP4 containers upstream.
- Auto-play and infinite discovery.

2. News (editorial)

- Each slide contains exactly 1 featured item and 3 related items.
- Related items provide context or reaction to the main story.
- A News scroll unit is a slide, and a For You scroll unit is a card.

Interaction model (MVP): like, bookmark, share, view, complete. Views are tracked via visibility and completes are tracked when media finishes.

## 3) System architecture & boundaries

Turfa is split into three runtime domains with strict boundaries:

1. CMS / Feed Service (Go)

- Serves public feed APIs and content retrieval for the app.
- Handles feed composition rules (For You cards, News slides).
- Executes vector similarity queries via pgvector.
- Must not scrape or run FFmpeg.

2. Aggregation Service (Node.js workers)

- Fetches/scrapes external sources, processes media, generates transcripts and embeddings.
- Writes content and artifacts back via CMS internal APIs.
- Must not serve user-facing API traffic.

3. Platform Console (Admin UI)

- Operates sources and ingestion, monitors content status.
- Calls CMS admin endpoints under /admin/\*.
- Uses CMS-issued JWT for admin access.

## 4) Technology stack (baseline)

Frontend:

- Next.js (App Router), shadcn/ui + Radix, Zustand + TanStack Query, Framer Motion.

Backend:

- Go + Gin, GORM, PostgreSQL + pgvector, Redis (optional caching).

Aggregation:

- Node.js worker fleet, BullMQ + Redis, FFmpeg, yt-dlp.
- Whisper for transcription.
- Embeddings model with 384-dimension vectors (e.g., all-MiniLM-L6-v2).

Storage:

- Supabase Storage or S3-compatible object storage.
- CDN for frontend delivery.

## 5) Platform data model (canonical tables)

Core platform tables:

- content_items: polymorphic content table for ARTICLE, VIDEO, TWEET, COMMENT, PODCAST.
- transcripts: transcript text and metadata for audio/video content.
- content_sources: source configs for ingestion jobs.
- user_interactions: like/bookmark/share/view/complete tracking.

Content item fields (high level):

- Content: title, body_text, excerpt.
- Media: media_url, thumbnail_url, original_url, duration_sec.
- Attribution: author, source_name, source_feed_url.
- AI: topic_tags, embedding vector(384), metadata JSONB.
- Status: PENDING → PROCESSING → READY/FAILED/ARCHIVED.

## 6) Required backend APIs (contract)

CMS public APIs consumed by the app:

- GET /api/v1/feed/foryou
- GET /api/v1/feed/news
- GET /api/v1/content/:id
- POST /api/v1/interactions
- GET /api/v1/interactions/bookmarks
- DELETE /api/v1/interactions/:id

CMS admin APIs consumed by Console (recommended under /admin/\*):

- Manage content_sources (CRUD)
- Trigger ingestion jobs
- Browse content_items with status/type filters

Aggregation → CMS internal/admin APIs (service-to-service):

- Upsert content items by idempotency key
- Update status transitions
- Attach artifacts (media_url, thumbnail_url, duration_sec)
- Create transcript and link to content_item

## 7) Aggregation pipeline (v1)

Supported sources (v1):

- Manual upload
- RSS news feeds (with per-domain allowlist for full-article scraping)
- Podcast RSS/iTunes search
- YouTube Data API v3
- X/Twitter and Reddit

Pipeline stages:

- Fetch → Normalize → Media → Transcript → Embeddings
- Each stage is independently retryable and updates status/fields via CMS APIs.

Artifacts:

- MP4 media for For You cards (required)
- Thumbnails
- Transcript text stored in transcripts table
- Embeddings stored in content_items.embedding (384 dims)

## 8) Feed response shapes

News feed response (1 featured + 3 related per slide):

```json
{
  "slides": [
    {
      "slide_id": "uuid-slide-1",
      "featured": {
        "id": "...",
        "title": "Big Tech News",
        "type": "ARTICLE",
        "image": "..."
      },
      "related": [
        { "id": "...", "body": "My reaction...", "type": "TWEET" },
        { "id": "...", "body": "Great insight", "type": "COMMENT" },
        { "id": "...", "title": "Analysis", "type": "ARTICLE" }
      ]
    }
  ]
}
```

For You feed response (MP4-ready):

```json
{
  "items": [
    {
      "id": "uuid-1",
      "type": "VIDEO",
      "url": "https://s3.../podcast_clip.mp4",
      "title": "The Future of AI",
      "duration": 120
    }
  ]
}
```

## 9) Discovery strategy (MVP)

Ranking combines:

- Semantic similarity (pgvector embedding distance).
- Freshness.
- Engagement signals.
- Diversity rules (avoid repeated topics/creators).

## 10) Success metrics (initial targets)

- Session duration target: > 15 minutes.
- Audio completion rate target: > 40%.
- Feed switch rate: % of users using both feeds in a session.

## 11) Security & auth

- Platform Console uses CMS-issued JWT (HS256 shared secret with CRM) for admin requests.
- CMS must allow CORS from Console origin and permit Authorization header for /admin/\*.
- Aggregation uses a service token when calling CMS internal APIs.

## 12) Environment variables (high level)

Frontend:

- NEXT_PUBLIC_API_URL
- NEXT_PUBLIC_USE_MOCK_DATA

CMS:

- DATABASE_URL
- ENV (development | dev | production)
- JWT_SECRET (shared with CRM if/when used)

Aggregation:

- CMS_BASE_URL
- CMS_SERVICE_TOKEN
- REDIS_URL
- STORAGE_BASE_URL / STORAGE_BUCKET

## 13) Current implementation status

Completed:

- Next.js app router setup and feed UI components.
- Mock data and feed layout for For You and News.

In progress / not started:

- Go CMS feed endpoints and pgvector integration in production.
- Redis caching and rate limiting.
- Aggregation worker fleet, FFmpeg processing, transcription, embeddings.
- Supabase Storage integration and CDN publishing.

## 14) Non-goals (v1)

- End-user portal beyond the main app.
- Advanced marketing automation and tenant billing.
- Queue internals UI and audit logging for ops.
