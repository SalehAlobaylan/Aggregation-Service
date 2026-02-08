# Operational Runbook: Wahb Aggregation Service

This runbook provides operational procedures for the Aggregation Service.

---

## Table of Contents

1. [Deployment](#deployment)
2. [Health Verification](#health-verification)
3. [Queue Operations](#queue-operations)
4. [DLQ Handling](#dlq-handling)
5. [Common Failures](#common-failures)
6. [Scaling](#scaling)
7. [Monitoring](#monitoring)

---

## Deployment

### Local Development (Docker Compose)

```bash
# 1. Copy environment template
cp .env.example .env

# 2. Edit .env with your values (required fields)
#    - CMS_BASE_URL, CMS_SERVICE_TOKEN
#    - REDIS_URL (default: redis://redis:6379)
#    - STORAGE_ENDPOINT, STORAGE_BUCKET

# 3. Start services
docker compose up -d

# 4. Verify readiness
curl http://localhost:5002/ready
```

### With Monitoring Stack

```bash
docker compose --profile monitoring up -d

# Access:
# - Metrics: http://localhost:5002/metrics
# - Prometheus: http://localhost:9090
# - Grafana: http://localhost:3002 (admin/admin)
```

### Production (Kubernetes)

```bash
# 1. Create secrets
kubectl create secret generic aggregation-secrets \
  --from-literal=CMS_SERVICE_TOKEN='your-token' \
  --from-literal=STORAGE_ACCESS_KEY='your-key' \
  --from-literal=STORAGE_SECRET_KEY='your-secret'

# 2. Apply manifests
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/hpa.yaml

# 3. Verify
kubectl get pods -l app=aggregation-service
kubectl logs -l app=aggregation-service --tail=50
```

---

## Health Verification

### Endpoints

| Endpoint | Purpose | Expected Response |
|----------|---------|-------------------|
| `GET /health` | Liveness probe | `{"status": "ok"}` |
| `GET /ready` | Readiness probe | `{"status": "ready", "dependencies": {...}}` |
| `GET /metrics` | Prometheus metrics | Text format metrics |

### Troubleshooting Readiness

```bash
# Check readiness with curl
curl -s http://localhost:5002/ready | jq

# Expected:
# {
#   "status": "ready",
#   "dependencies": {
#     "redis": "connected",
#     "cms": "reachable",
#     "storage": "configured"
#   }
# }
```

**If `redis: disconnected`:**
```bash
# Check Redis connectivity
docker compose logs redis
redis-cli -h localhost -p 6380 ping
```

**If `cms: unreachable`:**
```bash
# Verify CMS URL and token
curl -H "Authorization: Bearer $CMS_SERVICE_TOKEN" \
     "$CMS_BASE_URL/health"
```

---

## Queue Operations

### Inspecting Queue Depths

```bash
# Connect to Redis CLI
docker compose exec redis redis-cli

# Check waiting jobs per queue
LLEN bull:fetch:wait
LLEN bull:normalize:wait
LLEN bull:media:wait
LLEN bull:ai:wait

# Check active jobs
LLEN bull:fetch:active
```

### Via Prometheus Metrics

```bash
# Queue depth metric
curl -s http://localhost:5002/metrics | grep aggregation_queue_depth
```

### Pausing/Resuming Queues

Workers can be paused by setting `WORKER_CONCURRENCY=0` and restarting, but this is generally not recommended. Instead, scale replicas down:

```bash
# Kubernetes
kubectl scale deployment aggregation-service --replicas=0

# Docker Compose
docker compose stop aggregation
```

---

## DLQ Handling

### Checking DLQ Size

```bash
# Redis CLI
docker compose exec redis redis-cli
LLEN bull:dlq:wait

# Prometheus
curl -s http://localhost:5002/metrics | grep aggregation_dlq_size
```

### Inspecting DLQ Jobs

```bash
# View DLQ job details
docker compose exec redis redis-cli
LRANGE bull:dlq:wait 0 10
```

### Reprocessing DLQ Jobs

**⚠️ Warning:** Before reprocessing, ensure the root cause is resolved.

```bash
# 1. Inspect the first DLQ job
# 2. Fix the underlying issue
# 3. Move jobs back to original queue

# Option A: Use BullMQ Board (separate tool)
# Option B: Script-based reprocessing
npx tsx src/scripts/reprocess-dlq.ts --queue fetch --limit 10
```

### Safe DLQ Reprocessing Script

```typescript
// Create: src/scripts/reprocess-dlq.ts
import { getQueue, QUEUE_NAMES } from '../queues/index.js';

const dlqQueue = getQueue(QUEUE_NAMES.DLQ);
const targetQueue = process.argv[3]; // e.g., 'fetch'
const limit = parseInt(process.argv[5] || '10');

const jobs = await dlqQueue.getWaiting(0, limit);
for (const job of jobs) {
  const originalQueue = getQueue(job.data.originalQueue);
  await originalQueue.add(job.name, job.data.originalData);
  await job.remove();
  console.log(`Reprocessed: ${job.id}`);
}
```

---

## Common Failures

### 1. CMS Connectivity Issues

**Symptoms:**
- `CircuitBreakerOpen` errors in logs
- `aggregation_circuit_state{dependency="cms"} = 1`
- Jobs stuck in PROCESSING status

**Diagnosis:**
```bash
# Check circuit breaker state
curl -s http://localhost:5002/metrics | grep 'circuit_state.*cms'

# Check CMS logs
docker compose logs cms
```

**Resolution:**
1. Verify CMS is running and accessible
2. Check `CMS_SERVICE_TOKEN` is valid
3. Circuit will auto-recover after `CB_RESET_TIMEOUT_MS` (default: 30s)
4. Force reset (if needed):
   ```bash
   # Restart aggregation service
   docker compose restart aggregation
   ```

### 2. Storage Upload Failures

**Symptoms:**
- Media jobs failing after transcode
- `storage_operations_total{status="failed"}` increasing

**Diagnosis:**
```bash
# Check MinIO/S3 connectivity
mc alias set local http://localhost:9000 minioadmin minioadmin
mc ls local/wahb-media

# Check storage circuit breaker
curl -s http://localhost:5002/metrics | grep 'circuit_state.*storage'
```

**Resolution:**
1. Verify storage credentials in `.env`
2. Check bucket exists and has write permissions
3. For MinIO, verify container is running: `docker compose logs minio`

### 3. Whisper Transcription Timeouts

**Symptoms:**
- AI jobs timing out
- Long-running jobs in media queue

**Diagnosis:**
```bash
# Check Whisper container
docker compose logs whisper

# Check memory usage (Whisper needs 4GB+)
docker stats aggregation-whisper
```

**Resolution:**
1. Ensure Whisper has sufficient memory (4GB minimum)
2. For large files, transcription can take 5+ minutes
3. Consider using smaller ASR_MODEL (tiny, base) for faster processing

### 4. External API Rate Limiting

**Symptoms:**
- Fetch jobs failing for specific sources
- `rate_limit_hits_total` increasing

**Resolution:**
1. Rate limits are expected; jobs will be retried
2. Adjust `RATE_LIMIT_MAX_REQUESTS` if needed
3. Consider spreading job distribution over time

### 5. Redis Memory Issues

**Symptoms:**
- Jobs not being enqueued
- Redis errors in logs

**Diagnosis:**
```bash
docker compose exec redis redis-cli INFO memory
```

**Resolution:**
1. Increase Redis memory: `docker compose exec redis redis-cli CONFIG SET maxmemory 2gb`
2. Clear completed jobs: Jobs older than 24h are auto-cleaned
3. Check for job data size (large payloads should use references)

---

## Scaling

### Horizontal Scaling (Kubernetes)

```bash
# Manual scaling
kubectl scale deployment aggregation-service --replicas=5

# Check HPA status
kubectl get hpa aggregation-service-hpa

# View scaling events
kubectl describe hpa aggregation-service-hpa
```

### Vertical Scaling

Increase worker concurrency:
```bash
# Update deployment
kubectl set env deployment/aggregation-service WORKER_CONCURRENCY=10
```

### Scaling Guidelines

| Queue Depth | Recommended Action |
|-------------|-------------------|
| < 50 | Normal operation |
| 50-200 | Consider scaling up |
| > 200 | Scale up + investigate bottleneck |
| > 500 | Alert + immediate scaling |

---

## Monitoring

### Key Metrics to Watch

| Metric | Warning | Critical |
|--------|---------|----------|
| `aggregation_dlq_size` | > 10 | > 50 |
| `aggregation_queue_depth` | > 100 | > 500 |
| P95 job duration | > 60s | > 300s |
| Error rate | > 5% | > 15% |
| Circuit breaker open | any | > 5 min |

### Grafana Dashboard

Access at http://localhost:3002 (with monitoring profile)

Panels:
- Job Throughput (jobs/min)
- Success Rate
- Queue Depths
- P95/P99 Latencies
- Circuit Breaker States
- Resource Usage

### Log Analysis

```bash
# View structured logs
docker compose logs aggregation --tail=100 | jq

# Filter by level
docker compose logs aggregation | grep '"level":"error"'

# Filter by contentItemId
docker compose logs aggregation | grep 'contentItemId":"abc123'
```

---

## Emergency Procedures

### Stop All Processing

```bash
# Docker Compose
docker compose stop aggregation

# Kubernetes
kubectl scale deployment aggregation-service --replicas=0
```

### Drain Queues (Emergency)

⚠️ **Data Loss Warning:** Only use if absolutely necessary.

```bash
docker compose exec redis redis-cli
DEL bull:fetch:wait
DEL bull:normalize:wait
DEL bull:media:wait
DEL bull:ai:wait
```

### Force CMS Status Reset

If items are stuck in PROCESSING:
```bash
# Via CMS admin API (if available)
curl -X PATCH "$CMS_BASE_URL/content-items/batch-status" \
  -H "Authorization: Bearer $CMS_SERVICE_TOKEN" \
  -d '{"from_status": "PROCESSING", "to_status": "PENDING"}'
```
