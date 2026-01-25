# Turfa — CMS Context & Requirements (Integrated)

This document describes the Go-based CMS + Feed Service in this repository and how it fits into the wider Turfa platform. It consolidates project context from the context folder and describes every subsystem implemented under src.

## 1) What “CMS” is in this repo set

The CMS is a Go REST API that provides CRUD for Pages, Posts, and Media and also serves Turfa’s feed APIs and interaction endpoints. It is the primary backend for platform content delivery and the future admin surface. It uses Gin for HTTP routing, GORM for data access, and PostgreSQL with pgvector for similarity search.

Key responsibilities implemented in this repo:

- Core CMS CRUD (Pages, Posts, Media) with filtering, sorting, searching, and pagination.
- Feed Service endpoints for For You and News feeds (cursor pagination).
- Content retrieval endpoint for any content item by ID.
- User interaction endpoints (like, bookmark, view, share, complete) with idempotent handling for like/bookmark.
- Database setup, migration automation in development, and seeded demo data for the platform feed.

## 2) System location in Turfa

Turfa has three major runtime domains that share data and contract boundaries:

1. CMS / Feed Service (this repo)

- Serves public feed APIs and content retrieval used by the Web App.
- Handles feed composition rules (For You cards, News slides: 1 featured + 3 related).
- Executes vector similarity queries via pgvector (where applicable) and must not perform scraping or FFmpeg processing.

2. Aggregation Service (Node.js worker fleet)

- Performs ingestion, media processing, embeddings generation, and uploads to object storage.
- Writes to the platform database (content_items, transcripts, etc.) that this CMS reads.
- Does not serve user traffic.

3. Platform Console (Admin UI)

- Calls CMS admin APIs (recommended under /admin/\*) for content sources and content item management.
- Uses CMS-issued JWT (shared with CRM) and requires CORS allowances for Authorization headers.

Platform UX constraints (from PRD and LLM context):

- For You feed must return MP4 URLs. Any audio source must be converted upstream by the Aggregation Service.
- News feed must return slides with 1 featured item + 3 related items.
- Feed Service performs read and composition; Aggregation Service performs media processing and embeddings.

## 3) Runtime architecture & entry point (src/main.go)

The service boots from src/main.go and implements:

- Environment awareness via ENV (development/dev/production).
- Database connection via DATABASE_URL only; in development it ensures database existence.
- Auto-migration for all models during development and seed data for CMS + platform content.
- CORS set to allow all origins with common HTTP methods and Authorization header (suitable for cross-origin Console usage, with production tightening recommended).

Router structure:

- Root endpoints: / (welcome + endpoint list) and /health.
- API group: /api/v1 with CMS CRUD + feed + content + interactions.

## 4) Database schema & migrations

The repository uses two schema layers:

1. SQL migrations for the original CMS tables (src/migrations):

- pages: id, public_id (UUID), title, content, created_at, updated_at.
- media: id, public_id, url, type, created_at, updated_at.
- posts: id, public_id, title, content, author, created_at, updated_at.
- post_media: junction table for many-to-many Post ⟷ Media.

2. GORM AutoMigrate (development only) for platform tables:

- content_items
- transcripts
- user_interactions
- content_sources

PostgreSQL extensions required:

- pgcrypto (for UUID generation)
- vector (for embeddings)

## 5) Data models (src/models)

### 5.1 CMS models

Page

- public UUID id
- title, content
- created_at, updated_at

Post

- public UUID id
- title, content, author
- many-to-many relation with Media via post_media
- created_at, updated_at

Media

- public UUID id
- url, type
- many-to-many relation with Post via post_media
- created_at, updated_at

### 5.2 Platform models

ContentItem (content_items)

- Type enum: ARTICLE, VIDEO, TWEET, COMMENT, PODCAST
- Source enum: RSS, PODCAST, YOUTUBE, UPLOAD, MANUAL
- Status enum: PENDING, PROCESSING, READY, FAILED, ARCHIVED
- Content fields: title, body_text, excerpt
- Media fields: media_url, thumbnail_url, original_url, duration_sec
- Attribution: author, source_name, source_feed_url
- AI fields: topic_tags, embedding vector(384), metadata JSONB
- Engagement counters: like_count, comment_count, share_count, view_count
- Timestamps: published_at, created_at, updated_at

Transcript (transcripts)

- content_item_id (UUID)
- full_text, summary, word_timestamps JSONB, language
- created_at

UserInteraction (user_interactions)

- content_item_id (UUID)
- user_id or session_id (either can be used)
- type enum: like, bookmark, share, view, complete
- metadata JSONB
- created_at

ContentSource (content_sources)

- name, type (SourceType)
- feed_url, api_config JSONB
- is_active, fetch_interval_minutes, last_fetched_at
- metadata JSONB, created_at, updated_at

## 6) Controllers & API behavior (src/controllers)

### 6.1 Pages API

- CreatePage: validates required fields, inserts row, returns ResponseMessage.
- GetPages: list with pagination, filtering, sorting, search (QueryConfig fields: title, content, created_at, updated_at).
- GetPage: fetch by numeric id path param.
- UpdatePage: updates a page by numeric id.
- DeletePage: deletes by numeric id.

### 6.2 Posts API

- CreatePost: inserts post; if media public IDs are provided, resolves and associates via post_media.
- GetPosts: list with pagination, filtering, sorting, search (title, content, author).
- GetPost: fetch by public UUID.
- UpdatePost / DeletePost: update/delete by public UUID.

### 6.3 Media API

- CreateMedia: inserts media row.
- GetMedia: fetch single by public UUID or list with pagination, sorting, filtering, search (url/type/created_at/updated_at).
- DeleteMedia: delete by public UUID.

### 6.4 Feed API

For You (GET /api/v1/feed/foryou)

- Cursor-based pagination using published_at + public_id.
- Filters content_items for VIDEO and PODCAST with status READY.
- Returns items with interaction flags if session_id or user_id is provided.

News (GET /api/v1/feed/news)

- Cursor-based pagination for featured articles.
- Featured items are ARTICLE type with status READY.
- Related items are TWEET or COMMENT with status READY; grouped 3 per slide.
- Each slide has a generated slide_id.

### 6.5 Content API

- GetContentItem: returns a single content item by public UUID, including like/bookmark flags if session_id or user_id is present.

### 6.6 Interactions API

- CreateInteraction: records interaction; like/bookmark are idempotent per session/user + content.
- GetBookmarks: cursor-based list of bookmarked content for a session or user.
- DeleteInteraction: deletes an interaction by public UUID and updates engagement counters.

## 7) Routing (src/routes)

All routes are mounted under /api/v1 and map to the controllers above:

- /posts, /media, /pages (CRUD)
- /feed/foryou and /feed/news
- /content/:id
- /interactions, /interactions/bookmarks, /interactions/:id

## 8) Query, pagination, and response utilities (src/utils)

Query parsing and building

- ParseQueryParams normalizes page/limit/offset, validates sort fields, search fields, and filter operators.
- ApplyQuery builds GORM WHERE/ORDER clauses for filters, search, and sort.
- FetchWithPagination returns data + QueryMeta (page, limit, offset, total, total_pages, has_prev/has_next).
- BuildPaginationLinks returns HATEOAS links (self/next/prev/first/last).

Cursor pagination

- EncodeCursor/DecodeCursor use base64(timestamp_nano:uuid).
- ParseCursorParams enforces max feed limit 50 and default 20.

Database utilities

- ConnectDB uses DATABASE_URL only and ensures extensions (pgcrypto, vector).
- AutoMigrate and SeedData/SeedLumenData for development.

Seed data for platform

- SeedLumenData generates sample VIDEO/PODCAST, ARTICLE, TWEET, COMMENT content.
- Embeddings use mocked 384-dimension vectors for development/testing.

Response shapes

- ResponseMessage: { code, message, data, meta, links } for list endpoints.
- HTTPError: { code, message, data } for consistent error responses.

## 9) Tests (src/tests)

Integration tests

- Boot the full router with a real Postgres test database.
- Cover feed endpoints (For You, News, cursor pagination), content retrieval, interactions, posts, media, and setup/cleanup of tables.

Unit tests

- Use sqlmock with GORM to test controller behavior for pages, posts, and media.
- Validate error handling, invalid IDs, and transactional behavior.

## 10) External integrations and platform expectations

From the platform context and PRD:

- The frontend is a Next.js app expecting For You cards and News slides.
- Aggregation Service must handle media processing, scraping, and embeddings.
- This CMS must read from content_items and respond quickly with feed composition.

Required endpoints (platform contract)

- /api/v1/feed/foryou
- /api/v1/feed/news
- /api/v1/content/:id
- /api/v1/interactions
- /api/v1/interactions/bookmarks
- /api/v1/interactions/:id

## 11) Environment variables

Required

- DATABASE_URL: PostgreSQL connection string (the only supported DB configuration).

Optional

- ENV: development | dev | production (controls migrations/seed and Gin release mode).

## 12) Roadmap and constraints

Roadmap items referenced in project context:

- JWT authentication
- Redis integration (caching/session/rate limits)
- Rate limiting, GraphQL, enhanced user management with audit trails

Service boundary constraints:

- CMS/Feed Service must not scrape or run FFmpeg. Those responsibilities are handled by the Aggregation Service.
- For You feed must return MP4 URLs only, and any audio conversion must already be completed upstream.
