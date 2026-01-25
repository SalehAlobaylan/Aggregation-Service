# Turfa — Product Requirements Document (PRD)

Version: 1.3
Last Updated: January 18, 2026
Product Type: Social Media Platform
Platform: Web Application (Mobile-First)

## 1) Executive summary

Turfa is a mobile-first social platform that merges an audio-first “For You” feed with a magazine-style “News” feed, consumed via TikTok-style vertical snap scrolling. The product’s core innovation is “dual-mode discovery,” where users switch between immersive audio entertainment and premium journalism in one app.

Core value proposition:

- For consumers: discover podcasts and news without decision fatigue.
- For creators: viral discovery for audio content (podcasts, show clips).
- For publishers: premium, magazine-style presentation for journalism.

## 2) Core concept & feeds

Turfa has dual feeds: For You and News.

### 2.1 For You feed (audio-first)

- A vertical feed of audio-focused videos.
- Format is full-screen MP4 video; audio-only sources must be converted upstream.
- Experience is snap scrolling, auto-play, and infinite discovery.

### 2.2 News feed (editorial)

- A vertical feed of curated news slides.
- Each slide contains exactly 1 featured item and 3 related briefs.
- Experience is “magazine-like reading,” where related items provide context or reaction to the main story.

Scroll units:

- News: slide (1 featured + 3 related).
- For You: card (1 full-screen MP4).

## 3) MVP feature specifications

### 3.1 Interaction (MVP)

- Vertical snap scroll using CSS scroll-snap for full-page transitions.
- Auto-play videos immediately upon landing.
- Actions include Like, Comment, Share, Bookmark.
- Interaction triggers include like, bookmark, share, view (visibility-based), and complete (media finishes).

### 3.2 Content types (MVP)

- News featured items: articles and blogs.
- News related items: tweets, comments, and short articles.
- For You: MP4 videos sourced from podcasts and uploads.

## 4) Discovery strategy (MVP)

Ranking combines:

- Semantic similarity (vector search).
- Freshness.
- Engagement signals.
- Diversity rules to avoid repeated topics/creators.

## 5) Success metrics (initial targets)

- Session duration target: > 15 minutes.
- Audio completion rate target: > 40%.
- Feed switch rate: percentage of users using both feeds in one session.

## 6) System location & service boundaries

This PRD defines the user experience, feed shapes, and MVP outcomes that the Turfa Web App consumes and the backend services produce.

Service boundaries (must be respected):

- Aggregation Service: ingests external sources, runs FFmpeg conversions, generates transcripts and embeddings, and writes back via CMS internal APIs.
- CMS/Feed Service: reads content_items, runs pgvector similarity, assembles feeds, and serves JSON to the app.
- Platform Console: triggers ingestion and monitors content_items.status via CMS admin APIs.

## 7) Feed response shapes

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

## 8) Platform alignment (non-PRD but required constraints)

- For You must always return MP4 URLs; audio sources must be converted upstream.
- News slides must always follow 1 featured + 3 related rule.
- Vector search relies on pgvector with 384-dimension embeddings.
- content_items is the polymorphic content store for all types.
