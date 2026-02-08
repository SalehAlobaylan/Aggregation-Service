# Aggregation Service Run Guide

## Overview
- Aggregation is a worker fleet that pulls external sources (RSS/YouTube/Podcasts/Social/Manual), processes media, generates transcripts + embeddings, and writes to CMS internal APIs. It never serves user traffic.
- This guide assumes CMS, Redis, object storage, and Whisper are reachable in your environment.

## Requirements
- **Services**: PostgreSQL-backed CMS (:8080), Redis (:6379), object storage (MinIO/S3), Whisper API (:9002), optional yt-dlp/FFmpeg binaries.
- **Env variables** *(copy `.env.example` and populate)*:
  - `CMS_BASE_URL` should point to `http://<cms-host>/internal`.
  - `CMS_SERVICE_TOKEN` (same value in CMS `.env`).
  - Redis/Storage/Whisper creds (`REDIS_URL`, `STORAGE_*`, `WHISPER_API_URL`).
  - Optional provider keys: `YOUTUBE_API_KEY`, `REDDIT_*`, `TWITTER_BEARER_TOKEN`.
  - Feature flags: `ENABLE_ITUNES_SEARCH=true`.

## Run steps
1. Start CMS + ensure migrations/seeds have run. CMS must expose the internal routes protected by `CMS_SERVICE_TOKEN`.
2. Ensure Redis, MinIO/S3 bucket (`STORAGE_BUCKET`), and Whisper are running, then `npm install` in Aggregation.
3. Start Aggregation: `npm run dev` (or `npm run start` after build). Health/metrics listen on `metricsPort`.
4. Seed sources: `npm run seed` (or use `/admin/trigger` endpoints for manual/itinerary jobs).

## Flow highlights
- **Fetch → Normalize → Media → AI**: fetchers emit raw items → normalizers map to `content_items` → media worker downloads/transcodes → AI worker transcribes/embeds → CMS status transitions to READY.
- **Manual/UPLOAD sources**: payloads land in `FetchJob.config.settings.payload`; service skips download when `mediaReady` and `mediaUrl` exist, enqueueing AI directly.
- **iTunes discovery**: trigger a `PODCAST_DISCOVERY` job (admin GET `/admin/itunes/search` or scheduler) and the fetcher enqueues `PODCAST` jobs per feed.
- **Twitter**: API-only mode (`settings.mode=api`); scrape mode disabled.
- **CMS integration**: uses `/internal/content-items`, `/status`, `/artifacts`, `/embedding`, `/transcript`, `/transcripts`.

## Validation
- Run `npm run test:contract` after setting CMS env to ensure API compatibility.
- Execute one live ingestion per plan: RSS article, podcast + enclosure, manual upload; verify CMS status, artifacts, transcript link, and embedding vector length via CMS admin APIs.
- Monitor health via `/admin/queues`, `/metrics`, and Redis job counts.

## Notes
- Keep `CMS_SERVICE_TOKEN` in sync between Aggregation and CMS.
- Manual uploads can be tested via `/admin/trigger` with `sourceType: MANUAL`.
- For integrations, ensure object storage URLs are reachable from CMS (public URL used in feeds).
