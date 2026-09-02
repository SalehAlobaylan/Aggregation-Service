import { getQueue, QUEUE_NAMES } from "../queues/index.js";
import { cmsClient } from "../cms/client.js";
import { activeManagedProcessMetrics, activeManagedProcesses } from "../runtime/managed-process.js";
import { logger } from "../observability/logger.js";
import type { QueueName } from "../queues/schemas.js";

const timers = new Map<"news" | "pods", NodeJS.Timeout>();
const previousFailedCounts = new Map<"news" | "pods", number>();

const laneQueues = {
  news: { required: [QUEUE_NAMES.NEWS_ENRICHMENT], optional: [QUEUE_NAMES.NEWS_OPTIONAL] },
  pods: { required: [QUEUE_NAMES.PODS_MEDIA, QUEUE_NAMES.PODS_COMPLETION, QUEUE_NAMES.PODS_ATOMIZATION], optional: [QUEUE_NAMES.PODS_OPTIONAL] },
} as const;

async function queueStats(names: readonly QueueName[]) {
  let depth = 0;
  let oldest = 0;
  let failed = 0;
  const perQueue: Record<string, number> = {};
  const failureClasses: Record<string, number> = {};
  for (const name of names) {
    const queue = getQueue(name);
    if (!queue) continue;
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "prioritized", "failed");
    depth += counts.waiting + counts.active + counts.delayed + counts.prioritized;
    failed += counts.failed;
    perQueue[name] = counts.waiting + counts.active + counts.delayed + counts.prioritized;
    const failedJobs = await queue.getJobs(["failed"], 0, 49, false);
    for (const job of failedJobs) {
      const reason = String(job.failedReason || "unknown").slice(0, 80).replace(/[^a-zA-Z0-9_.:-]/g, "_");
      failureClasses[reason] = (failureClasses[reason] ?? 0) + 1;
    }
    const [job] = await queue.getJobs(["waiting", "prioritized", "delayed"], 0, 0, false);
    if (job?.timestamp) oldest = oldest === 0 ? job.timestamp : Math.min(oldest, job.timestamp);
  }
  return { depth, failed, oldestAgeSeconds: oldest === 0 ? 0 : Math.max(0, (Date.now() - oldest) / 1000), perQueue, failureClasses };
}

export async function publishPipelineLaneSnapshot(lane: "news" | "pods"): Promise<void> {
  const queues = laneQueues[lane];
  const [required, optional] = await Promise.all([queueStats(queues.required), queueStats(queues.optional)]);
  const failed = required.failed + optional.failed;
  const previousFailed = previousFailedCounts.get(lane) ?? failed;
  previousFailedCounts.set(lane, failed);
  const failureClasses = { ...required.failureClasses };
  for (const [failureClass, count] of Object.entries(optional.failureClasses)) {
    failureClasses[failureClass] = (failureClasses[failureClass] ?? 0) + count;
  }
  const stageCounts = { ...required.perQueue, ...optional.perQueue };
  await cmsClient.putPipelineLaneSnapshot({
    lane,
    required_queue_depth: required.depth,
    optional_queue_depth: optional.depth,
    required_oldest_age_seconds: required.oldestAgeSeconds,
    optional_oldest_age_seconds: optional.oldestAgeSeconds,
    dlq_delta: Math.max(0, failed - previousFailed),
    failure_classes: failureClasses,
    stage_counts: stageCounts,
    process_metrics: {
      pid: process.pid,
      rss_bytes: process.memoryUsage().rss,
      heap_used_bytes: process.memoryUsage().heapUsed,
      managed_children: activeManagedProcesses().length,
      managed_children_metrics: activeManagedProcessMetrics(),
    },
    resource_metrics: {},
    captured_at: new Date().toISOString(),
  }, `pipeline-snapshot:${lane}`);
}

export function startPipelineLaneSnapshots(lane: "news" | "pods"): void {
  if (timers.has(lane)) return;
  void publishPipelineLaneSnapshot(lane).catch((error) => logger.debug("Pipeline snapshot deferred", { lane, error: error instanceof Error ? error.message : String(error) }));
  const timer = setInterval(() => void publishPipelineLaneSnapshot(lane).catch((error) => logger.debug("Pipeline snapshot deferred", { lane, error: error instanceof Error ? error.message : String(error) })), 15_000);
  timer.unref();
  timers.set(lane, timer);
}

export function stopPipelineLaneSnapshots(): void {
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
  previousFailedCounts.clear();
}
