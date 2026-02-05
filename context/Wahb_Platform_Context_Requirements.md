# Wahb Platform — Complete Context & Requirements (formerly “Wahb Platform”)

This document consolidates product requirements, architecture, and the current frontend implementation under src. It integrates the context files in contex and the project docs to provide a complete, implementation-aware description of the Wahb platform.

## 1) Executive Summary

Wahb is a mobile-first social platform built around dual-mode discovery:

- **For You feed:** TikTok-style full-screen, snap-scrolling audio/video cards.
- **News feed:** Magazine-style slides with 1 featured article and 3 related items.

The core interaction model includes like, bookmark, share, view tracking via Intersection Observer, and completion when media finishes playing. The UX is designed for infinite discovery with low-friction switching between feeds.

## 2) Product Experience & UX Constraints

### 2.1 For You (audio-first)

- Full-screen MP4 videos like tiktok (audio-only sources must be converted to MP4 upstream).
- Auto-play on active card; tap to pause/play.
- Infinite scroll with snap behavior; one card is one scroll unit.

### 2.2 News (editorial)

- One scroll unit equals one slide containing:
  - **1 featured article** (headline, image, excerpt).
  - **3 related items** (tweet/comment/short article) for context or reaction.

### 2.3 Interaction model (MVP)

- Like, bookmark, share, view, complete.
- Views are tracked when a card/slide enters the viewport.
- Completion is tracked when media finishes (planned in backend contract).

## 3) System Architecture (System Location)

Wahb is split into three runtime domains with strict boundaries:

1. **Frontend Web App (Next.js)**
   - Mobile-first UI with App Router.
   - Feeds and interactions only; no scraping or media processing.

2. **CMS / Feed Service (Go + Gin)**
   - Serves feed APIs, content retrieval, and interaction endpoints.
   - Executes pgvector similarity queries.
   - Does **not** run FFmpeg or ingest external sources.

3. **Aggregation Service (Node.js worker fleet)**
   - Ingests external sources, processes media (FFmpeg), generates transcripts and embeddings.
   - Writes content and artifacts back to CMS internal APIs.
   - Never serves user-facing API traffic.

Storage uses Supabase Storage (or S3-compatible) for media artifacts and a CDN for frontend delivery.

## 4) Technology Stack (Baseline)

- **Frontend:** Next.js (App Router), shadcn/ui + Radix, Zustand, TanStack Query, Framer Motion.
- **Backend:** Go + Gin, GORM, PostgreSQL + pgvector, Redis (optional caching).
- **Workers:** Node.js, BullMQ, FFmpeg, Whisper, yt-dlp.
- **AI:** 384-dimension embeddings (all-MiniLM-L6-v2) stored in pgvector.

## 5) Platform Data Model (Canonical)

Primary tables:

- **content_items** (polymorphic): ARTICLE, VIDEO, TWEET, COMMENT, PODCAST.
- **transcripts**: transcript text and metadata linked to content_items.
- **user_interactions**: like/bookmark/share/view/complete.
- **content_sources**: source configs for ingestion.

Key content fields include title/body/excerpt, media URLs, transcript linkage, embedding vector(384), tags, metadata JSONB, engagement counters, and timestamps.

## 6) Required Backend APIs (Contract)

Public CMS APIs consumed by the app:

- GET `/api/v1/feed/foryou`
- GET `/api/v1/feed/news`
- GET `/api/v1/content/:id`
- POST `/api/v1/interactions`
- GET `/api/v1/interactions/bookmarks`
- DELETE `/api/v1/interactions/:id`

Response shapes:

- **For You:** `cursor` + `items[]` with media_url, thumbnail_url, duration_sec, counts, flags.
- **News:** `cursor` + `slides[]` where each slide has `slide_id`, `featured`, `related[]`.

## 7) Frontend Implementation (src)

This repository currently contains the **Next.js frontend** implementation. The src folder is organized around feeds, reusable UI components, client state, and API hooks.

### 7.1 App routing and layouts

- **App Router entry:** [src/app/layout.tsx](src/app/layout.tsx)
  - Global fonts (DM Sans, Playfair Display), dark theme, and base layout.
  - Wraps children with React Query providers and renders BottomNav.

- **Global styles:** [src/app/globals.css](src/app/globals.css)
  - Tailwind + tw-animate setup, CSS variables, light/dark design tokens.

- **Feed layout:** [src/app/(feeds)/layout.tsx](<src/app/(feeds)/layout.tsx>)
  - Full-height container for snap-scroll feeds.

- **For You page:** [src/app/(feeds)/page.tsx](<src/app/(feeds)/page.tsx>)
  - Infinite scroll with active card tracking, feed header + switcher, skeletons and error fallback.

- **News page:** [src/app/(feeds)/news/page.tsx](<src/app/(feeds)/news/page.tsx>)
  - Infinite scroll for slides, magazine layout, skeletons, and error fallback.

### 7.2 Feed components

- **FeedContainer:** [src/components/feed/feed-container.tsx](src/components/feed/feed-container.tsx)
  - Scroll-snap container with hidden scrollbar.
- **ForYouCard:** [src/components/feed/for-you-card.tsx](src/components/feed/for-you-card.tsx)
  - Full-screen MP4 card with autoplay, play/pause, progress bar, and actions.
- **NewsSlide:** [src/components/feed/news-slide.tsx](src/components/feed/news-slide.tsx)
  - Magazine-style slide with featured item + 3 related items.
- **Skeletons:** [src/components/feed/feed-skeleton.tsx](src/components/feed/feed-skeleton.tsx)
  - Loading placeholders for both feeds.
- **View tracking:** [src/components/feed/view-tracker.tsx](src/components/feed/view-tracker.tsx)
  - Intersection Observer tracking to record views.
- **Pull to refresh:** [src/components/feed/pull-to-refresh.tsx](src/components/feed/pull-to-refresh.tsx)
  - Touch-based pull-to-refresh wrapper (available but not wired into pages yet).

### 7.3 Layout components

- **Bottom navigation:** [src/components/layout/bottom-nav.tsx](src/components/layout/bottom-nav.tsx)
  - Fixed nav with Home, Discover, Create, Saved, Profile.
- **Feed switcher:** [src/components/layout/feed-switcher.tsx](src/components/layout/feed-switcher.tsx)
  - Toggle between For You and News based on route.

### 7.4 UI primitives

Shared shadcn/ui components:

- Button, Card, ScrollArea, Separator, Skeleton, Tabs.

Files:

- [src/components/ui/button.tsx](src/components/ui/button.tsx)
- [src/components/ui/card.tsx](src/components/ui/card.tsx)
- [src/components/ui/scroll-area.tsx](src/components/ui/scroll-area.tsx)
- [src/components/ui/separator.tsx](src/components/ui/separator.tsx)
- [src/components/ui/skeleton.tsx](src/components/ui/skeleton.tsx)
- [src/components/ui/tabs.tsx](src/components/ui/tabs.tsx)

### 7.5 Providers & error handling

- **React Query provider:** [src/components/providers.tsx](src/components/providers.tsx)
  - Query client with retries, stale time, and devtools.
- **Error boundary + feed fallback:** [src/components/error-boundary.tsx](src/components/error-boundary.tsx)
  - User-friendly error UI with retry.

### 7.6 Client state (Zustand)

- **Feed store:** [src/lib/stores/feed-store.ts](src/lib/stores/feed-store.ts)
  - Tracks active index, playback state, progress, playback speed, liked/bookmarked IDs.
  - Persists preferences; generates a session ID for anonymous interaction tracking.

### 7.7 Data fetching & API layer

- **API client:** [src/lib/api/feeds.ts](src/lib/api/feeds.ts)
  - Fetches feeds, content items, and records interactions.
- **Mock client:** [src/lib/api/mock-client.ts](src/lib/api/mock-client.ts)
  - Simulated API for local UI testing.
- **Hooks:** [src/lib/hooks/use-feed.ts](src/lib/hooks/use-feed.ts)
  - `useForYouFeed`, `useNewsFeed`, `useBookmarks`, `useLikeMutation`, `useBookmarkMutation`, `useTrackingMutation`.

### 7.8 Types & mocks

- **Feed types:** [src/types/feed.ts](src/types/feed.ts)
  - Content types, response shapes, and interaction types.
- **Mock data:** [src/lib/mocks/data.ts](src/lib/mocks/data.ts)
  - Placeholder items for For You and News feeds.

### 7.9 Tests

- **Feed component tests:**
  - [src/components/feed/**tests**/for-you-card.test.tsx](src/components/feed/__tests__/for-you-card.test.tsx)
  - [src/components/feed/**tests**/news-slide.test.tsx](src/components/feed/__tests__/news-slide.test.tsx)
- **API mock tests:**
  - [src/lib/api/**tests**/feeds.test.ts](src/lib/api/__tests__/feeds.test.ts)

## 8) Environment Variables

Frontend:

- `NEXT_PUBLIC_API_URL` — backend API base URL.
- `NEXT_PUBLIC_USE_MOCK_DATA` — toggle mock data mode for the UI.

Backend and worker env variables are defined in the system context files, including `DATABASE_URL`, `CMS_BASE_URL`, `CMS_SERVICE_TOKEN`, `REDIS_URL`, and storage settings.

## 9) Current Implementation Status

**Completed (frontend):**

- Next.js App Router setup with mobile-first feed layouts.
- For You feed UI and News feed magazine layout.
- Feed skeletons, error boundary, view tracking, and infinite scroll.
- API integration with mock mode and interaction wiring.

**In progress / not started (platform):**

- Go CMS endpoints and production-ready pgvector queries.
- Aggregation worker fleet (FFmpeg, Whisper transcription, embeddings).
- Supabase Storage integration and media pipeline.
- Platform Console admin UI integration (sources + content management).
