# Aggregation-Service

The ingestion and media-atomization pipeline for the Wahb platform. A **worker-first** Node.js service that fetches content from external sources, normalizes it, creates playback renditions and chapter cuts with FFmpeg, delegates ML to Media + Enrichment, and writes finished content into CMS via `/internal/*`. It also runs automated source **discovery** and a source-intelligence graph.

It does **not** serve user-facing feeds, assemble feeds, or run ML models itself — those belong to CMS, Enrichment, and Media. The Fastify HTTP surface exists only for health/metrics, admin triggers (Platform-Console), and one internal inbound route.

**Port:** 5002 (HTTP: health/ready/metrics/admin/internal) · **Production:** https://wahb-broker.salehspace.dev · **Stack:** Node.js 20+, TypeScript, Fastify, BullMQ, Redis, FFmpeg

> Full architecture, worker, and queue reference: [`../docs/aggregation-service.md`](../docs/aggregation-service.md). Product intent: [`../docs/PRD.md`](../docs/PRD.md).

## Architecture

```
  Sources (RSS / WEBSITE / YouTube / Podcast / Reddit / Telegram / Twitter / Upload)
                    │
                    ▼
            fetch-queue ──▶ normalize-queue ──┬──▶ media-queue   (FFmpeg renditions, Media transcribe)
                                              └──▶ ai-queue      (Enrichment embed + tags, Media image-embed)
                                                       │
                                       CMS /internal/* write-back ──▶ status = READY
                                                       │
                                      atomization-sweep ──▶ atomization-queue
                                                       │
                                      Enrichment chapter plan + FFmpeg cuts
                                                       │
                                      CMS child feed units + child embeddings
```

Background subsystems run alongside the main pipeline: **Media Atomization** (long podcasts/videos into chapters), **Feeds-Finding discovery** (auto-find sources), the **Source Intelligence Graph** (PageRank over a source link graph), storage lifecycle sweeps, media quality re-encode, and an embedding-reconciliation backstop. Schedules/toggles for these come from CMS config tables, not env.

**BullMQ queues** (Redis db=0): `fetch`, `normalize`, `media`, `ai`, `atomization`, `atomization-sweep`, `storage-sweep`, `reconcile`, `quality-reencode`, `discovery`, `discovery-sweep`, `source-graph`, plus `aggregation-dlq`. Defaults: 3 attempts, exponential backoff; completed kept 1h, failed 24h.

## Media Atomization

Aggregation executes atomization; CMS owns policy and feed visibility.

- Only parent media longer than 2400 seconds (>40m) should enter atomization. Do not atomize 15m/30m parents by default.
- CMS owns tenant/source/episode policy, exclusions, and manual-trigger validation. Aggregation only queues/executes manual atomization after CMS proxies a validated request.
- The worker waits for timestamped transcripts, calls Enrichment `/v1/chapters/generate`, normalizes boundaries, merges chapters below 270s with the best legal adjacent neighbor, cuts media with FFmpeg, creates HLS/MP4/audio renditions, writes child feed units to CMS, and queues child embeddings.
- Visible child feed units must be 270-2400 seconds. If a sub-270s chapter cannot legally merge, it stays hidden/review-only.
- Re-atomization must be idempotent: stable parent job IDs, old children archived/replaced through CMS, and no duplicate visible sibling chapters.

## Quick Start

```bash
# 1. Configure
cp .env.example .env        # edit values

# 2. Run with Docker (aggregation + redis + minio)
docker compose up -d
curl http://localhost:5002/ready

# — or — run locally
npm install
docker compose up -d redis minio    # local infra only
npm run dev                          # tsx watch, HTTP on :5002
```

## Configuration

Env is for boot-time infrastructure and credentials only. Algorithm/cadence knobs that admins tune at runtime live in CMS config tables (Config Discipline). See `.env.example` for the full list.

### Core (required)

| Variable | Purpose |
|----------|---------|
| `REDIS_URL` | BullMQ broker (db=0) |
| `CMS_BASE_URL` / `CMS_SERVICE_TOKEN` | CMS `/internal` write-back |
| `ENRICHMENT_BASE_URL` / `ENRICHMENT_SERVICE_TOKEN` | Text embedding + tags |
| `MEDIA_BASE_URL` / `MEDIA_SERVICE_TOKEN` | Transcription + image embedding |
| `INTERNAL_SERVICE_TOKEN` | Auth for the inbound `/internal` route |
| `JWT_SECRET` / `ADMIN_JWT_ISSUER` / `ADMIN_JWT_AUDIENCE` / `ADMIN_ALLOWED_ROLES` | Admin route auth |
| `STORAGE_ENDPOINT` / `STORAGE_BUCKET` / `STORAGE_REGION` / `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` / `STORAGE_PUBLIC_URL` | Hot object storage (S3 / R2 / MinIO) |

### Common (optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `METRICS_PORT` | 5002 | HTTP / metrics port |
| `WORKER_CONCURRENCY` | 5 | Concurrent jobs per worker |
| `LOG_LEVEL` | info | debug / info / warn / error |
| `ASYNC_TRANSCRIBE_THRESHOLD_SEC` | — | Duration cutoff for sync vs async transcription |
| `MEDIA_JOB_TIMEOUT_MS` / `DEFAULT_JOB_TIMEOUT_MS` | 30min / 5min | Job timeouts |
| `RATE_LIMIT_MAX_REQUESTS_*` (RSS/PODCAST/REDDIT/TELEGRAM/TWITTER/YOUTUBE/ITUNES), `RATE_LIMIT_WINDOW_MS*` | — | Per-source rate limits |
| `RECONCILE_ENABLED` / `RECONCILE_INTERVAL_MS` / `RECONCILE_BATCH` | — | Embedding reconcile sweep |
| `CB_FAILURE_THRESHOLD` / `CB_RESET_TIMEOUT_MS` / `CB_HALF_OPEN_REQUESTS` | 5 / 30000 / 3 | Circuit breaker (CMS client) |
| `PLATFORM_CONSOLE_ORIGINS` | localhost:3005,3000 | CORS origins |

### Per-source credentials

`TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_SESSION_STRING`, `TWITTER_BEARER_TOKEN`, `REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD`, `YOUTUBE_API_KEY` / `YOUTUBE_QUOTA_LIMIT`, `TAVILY_API_KEY`, and cold-storage `COLD_STORAGE_*` / `CLOUDFLARE_*`. Several of these are read in code but **not yet listed in `.env.example`** — add them when enabling that source.

### WEBSITE source settings (in `config.settings`)

```json
{
  "url": "https://example.com/news",
  "selectors": { "item": "article", "link": "a[href]", "title": "h2", "excerpt": "p.summary", "author": ".author", "date": "time" },
  "maxItems": 30
}
```

## Development

```bash
npm run dev          # tsx watch (HTTP on :5002)
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
npm run lint         # eslint

# Tests (vitest)
npm test             # all
npm run test:unit
npm run test:contract
npm run test:failure
npm run test:integration
npm run test:e2e
npm run test:load    # synthetic producer

# Operational scripts
npm run telegram:auth   # authenticate a Telegram session string
npm run retry-failed    # re-queue failed BullMQ jobs
npm run retry-pending   # re-queue stuck PENDING items
npm run seed            # seed jobs
npm run test:media      # exercise a media job
npm run test:ai         # exercise an AI job
```

## HTTP Surface

No public/consumer routes. Admin routes require an admin JWT (`verifyAdminAuth`); internal routes use `INTERNAL_SERVICE_TOKEN`.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` · `/ready` · `/metrics` | none | Liveness · readiness · Prometheus (queue depth, DLQ size) |
| POST | `/admin/trigger`, `/admin/trigger/{rss,youtube,reddit}` | JWT | Trigger ingestion for a source |
| POST | `/admin/discover` · `/admin/preview` | JWT | Feed discovery from a URL · fetch+normalize preview (no CMS write) |
| POST | `/admin/discovery/{run,sweep-now,build-graph-now,resync-schedule}` | JWT | Discovery + source-graph control |
| POST | `/admin/atomization/sweep-now` | JWT | Manually enqueue the atomization sweeper |
| POST | `/admin/atomization/parents/:id/atomize` | JWT via CMS | Queue one CMS-validated parent for transcript-first atomization or direct atomization |
| GET/POST | `/admin/queues*`, `/admin/jobs/:id`, `/admin/retry-failed`, `/admin/retry-pending` | JWT | Queue & job ops |
| GET/POST | `/admin/ratelimits*`, `/admin/scheduled`, `/admin/storage/*`, `/admin/quality/*`, `/admin/itunes/search`, `/admin/restart` | JWT | Rate-limit, schedule, storage, quality, ops |
| POST | `/internal/jobs/user-content` | token | Inject user-submitted content into the pipeline |

## Monitoring

```bash
docker compose --profile monitoring up -d
```

| Service | URL |
|---------|-----|
| Metrics | http://localhost:5002/metrics |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3002 (admin / admin) |

## Production Deployment

Deployed on **Cranl** (https://wahb-broker.salehspace.dev) via Dockerfile + GitHub trigger; see the `cranl-deploy` skill. Kubernetes manifests in `k8s/` and a standalone image are also supported:

```bash
docker build -t aggregation-service:latest .
docker run -d --env-file .env aggregation-service:latest

# Kubernetes
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/hpa.yaml
```

## Project Structure

```
src/
├── index.ts        # boot: Redis → queues → workers → HTTP server
├── config/         # env parsing + validation (Zod)
├── queues/         # BullMQ queue + schema definitions, retry routing
├── workers/        # job processors (fetch, normalize, media, ai, atomization, discovery, …)
├── fetchers/       # per-source fetchers (rss, website, youtube, podcast, reddit, telegram, twitter, manual)
├── normalizers/    # raw → canonical content shape
├── media/          # FFmpeg rendition + media handling
├── ai/             # Enrichment + Media service clients, embedding text builder
├── services/       # discovery/ (Feeds-Finding) + intel/ (source graph, PageRank)
├── storage/        # S3 / R2 object storage
├── cms/            # CMS API client
├── observability/  # pino logs, prom-client metrics
└── server/         # Fastify routes (health, ready, metrics, admin, internal)
tests/              # unit / contract / failure / integration / e2e / load
monitoring/         # Prometheus + Grafana configs
k8s/                # Kubernetes manifests
```

## License

Private — Wahb Platform
