/** Fail-closed worker role registration and lifecycle management. */
import type { Worker } from "bullmq";
import { logger } from "../observability/logger.js";
import { getInitializedQueueNames, getInitializedQueueRole } from "../queues/index.js";
import { reapExpiredLocalScratch } from "../runtime/local-reservations.js";
import { resolveRoleTopology, WORKER_DESCRIPTORS, type StartupHookId, type WorkerRole } from "../runtime/role-topology.js";

export type { WorkerRole } from "../runtime/role-topology.js";

let workers: Worker[] = [];
let activeRole: WorkerRole | null = null;
let startPromise: { role: WorkerRole; promise: Promise<void> } | null = null;
let closing = false;
let closePromise: Promise<void> | null = null;
let terminateRole: (code: number) => never = (code) => process.exit(code);
const startupHookStates = new Map<StartupHookId, { status: "pending" | "ready" | "failed"; attempts: number; error?: string; updatedAt: string }>();
const startupHookRetryTimers = new Map<StartupHookId, NodeJS.Timeout>();
const STARTUP_HOOK_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 20_000] as const;

export function getStartupHookReadiness(): Array<{ hook: StartupHookId; status: "pending" | "ready" | "failed"; attempts: number; error?: string; updated_at: string }> {
  return [...startupHookStates.entries()].map(([hook, state]) => ({ hook, status: state.status, attempts: state.attempts, error: state.error, updated_at: state.updatedAt }));
}

export interface WorkerOwnershipSnapshot {
  role: WorkerRole | null;
  expectedConsumers: string[];
  registeredConsumers: string[];
  missingConsumers: string[];
  unexpectedConsumers: string[];
  requiredQueueClients: string[];
  initializedQueueClients: string[];
  missingQueueClients: string[];
  unexpectedQueueClients: string[];
  startupHooks: string[];
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const allowed = new Set(right);
  return left.filter((value) => !allowed.has(value));
}

function duplicateValues(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

export function getWorkerOwnership(role: WorkerRole | null = activeRole): WorkerOwnershipSnapshot {
  if (!role) {
    const registeredConsumers = workers.map((worker) => worker.name);
    return {
      role: null,
      expectedConsumers: [],
      registeredConsumers,
      missingConsumers: [],
      unexpectedConsumers: registeredConsumers,
      requiredQueueClients: [],
      initializedQueueClients: getInitializedQueueNames(),
      missingQueueClients: [],
      unexpectedQueueClients: getInitializedQueueNames(),
      startupHooks: [],
    };
  }
  const topology = resolveRoleTopology(role);
  const registeredConsumers = workers.map((worker) => worker.name);
  const initializedQueueClients = getInitializedQueueNames();
  return {
    role,
    expectedConsumers: [...topology.consumerQueues],
    registeredConsumers,
    missingConsumers: difference(topology.consumerQueues, registeredConsumers),
    unexpectedConsumers: difference(registeredConsumers, topology.consumerQueues),
    requiredQueueClients: [...topology.queueClients],
    initializedQueueClients,
    missingQueueClients: difference(topology.queueClients, initializedQueueClients),
    unexpectedQueueClients: difference(initializedQueueClients, topology.queueClients),
    startupHooks: [...topology.startupHooks],
  };
}

function assertExactOwnership(role: WorkerRole, candidates: readonly Worker[]): void {
  const topology = resolveRoleTopology(role);
  const actual = candidates.map((worker) => worker.name);
  const duplicates = duplicateValues(actual);
  const missing = difference(topology.consumerQueues, actual);
  const unexpected = difference(actual, topology.consumerQueues);
  const initializedRole = getInitializedQueueRole();
  const initializedQueueClients = getInitializedQueueNames();
  const missingQueueClients = difference(topology.queueClients, initializedQueueClients);
  const unexpectedQueueClients = difference(initializedQueueClients, topology.queueClients);
  if (initializedRole !== role || duplicates.length || missing.length || unexpected.length || missingQueueClients.length || unexpectedQueueClients.length) {
    throw new Error(`Invalid ${role} worker ownership: queueRole=${initializedRole ?? "none"}; duplicates=${duplicates.join(",")}; missing=${missing.join(",")}; unexpected=${unexpected.join(",")}; missingQueueClients=${missingQueueClients.join(",")}; unexpectedQueueClients=${unexpectedQueueClients.join(",")}`);
  }
}

async function closeConstructed(candidates: readonly Worker[]): Promise<void> {
  await Promise.all(candidates.map(async (worker) => {
    try {
      await worker.close();
    } catch (error) {
      logger.warn("Failed to close partially constructed worker", { queue: worker.name, error: error instanceof Error ? error.message : String(error) });
    }
  }));
}

async function constructWorkers(role: WorkerRole): Promise<Worker[]> {
  const topology = resolveRoleTopology(role);
  const constructed: Worker[] = [];
  try {
    for (const workerId of topology.workerIds) {
      const factory = await WORKER_DESCRIPTORS[workerId].loadFactory();
      if (typeof factory !== "function") throw new Error(`Worker factory ${workerId} is unavailable`);
      constructed.push(factory());
    }
    assertExactOwnership(role, constructed);
    return constructed;
  } catch (error) {
    await closeConstructed(constructed);
    throw error;
  }
}

async function handleUnexpectedWorkerExit(role: WorkerRole, worker: Worker, error: unknown): Promise<void> {
  if (closing || activeRole !== role || !workers.includes(worker)) return;
  logger.error("Worker run loop terminated unexpectedly; stopping role", { role, queue: worker.name, error: error instanceof Error ? error.message : String(error) });
  await closeWorkers().catch((closeError) => logger.error("Failed to close role after worker run-loop termination", closeError));
  terminateRole(1);
}

function startValidatedWorkers(role: WorkerRole, candidates: readonly Worker[]): void {
  for (const worker of candidates) {
    let runPromise: Promise<void>;
    try {
      runPromise = worker.run();
    } catch (error) {
      throw new Error(`Failed to start worker ${worker.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    void runPromise.then(
      () => handleUnexpectedWorkerExit(role, worker, new Error("worker run loop exited")),
      (error) => handleUnexpectedWorkerExit(role, worker, error),
    );
  }
}

async function runStartupHook(hook: StartupHookId): Promise<void> {
  switch (hook) {
    case "news-dispatcher":
      (await import("../services/content-stage-dispatcher.js")).startContentStageDispatcher("news", ["news_text_embedding", "news_llm_metadata"]);
      return;
    case "pods-control-dispatcher":
      (await import("../services/content-stage-dispatcher.js")).startContentStageDispatcher("pods", ["pods_text_embedding", "pods_atomization", "pods_caption_reembedding", "pods_llm_metadata"]);
      return;
    case "pods-media-dispatcher":
      (await import("../services/content-stage-dispatcher.js")).startContentStageDispatcher("pods", ["pods_media_artifacts"]);
      return;
    case "news-lane-snapshot":
      (await import("../services/pipeline-lane-snapshot.js")).startPipelineLaneSnapshots("news");
      return;
    case "pods-lane-snapshot":
      (await import("../services/pipeline-lane-snapshot.js")).startPipelineLaneSnapshots("pods");
      return;
    case "atomization-sweeper": return syncAtomizationSweeper();
    case "storage-sweepers": return syncRepeatableSweepers();
    case "reconcile-sweeper": return syncReconcileSweeper();
    case "discovery-sweeper": return syncDiscoverySweeper();
    case "source-graph-sweeper": return syncSourceGraphSweeper();
    case "news-circulation-sweeper": return syncNewsCirculationSweeper();
    case "media-circulation-sweeper": return syncMediaCirculationSweeper();
    case "source-run-dispatch-sweeper": return syncSourceRunDispatchSweeper();
    case "source-run-verification-sweeper": return syncSourceRunVerificationSweeper();
    case "lifecycle-receipt-sweeper": return syncLifecycleReceiptActionSweeper();
    case "pipeline-repair-sweeper": return syncPipelineRepairSweeper();
    case "legacy-media-priority-repair": {
      const repaired = await (await import("../services/ai-queue-priority.js")).reprioritizePendingMediaAIJobs();
      if (repaired > 0) logger.info("Reprioritized pending media AI jobs", { count: repaired });
      return;
    }
    case "op-metrics-flush":
      (await import("./op-metrics-flush.worker.js")).startOpMetricsFlush();
      return;
    case "cloudflare-analytics":
      (await import("../services/cloudflare-analytics.service.js")).startCloudflareAnalyticsPuller();
      return;
  }
}

async function startRoleHooks(role: WorkerRole): Promise<void> {
  const runWithRetry = async (hook: StartupHookId): Promise<void> => {
    const previous = startupHookStates.get(hook);
    const attempts = (previous?.attempts ?? 0) + 1;
    startupHookStates.set(hook, { status: "pending", attempts, updatedAt: new Date().toISOString() });
    try {
      await runStartupHook(hook);
      startupHookStates.set(hook, { status: "ready", attempts, updatedAt: new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryIndex = attempts - 1;
      const final = retryIndex >= STARTUP_HOOK_RETRY_MS.length;
      startupHookStates.set(hook, { status: final ? "failed" : "pending", attempts, error: message, updatedAt: new Date().toISOString() });
      logger.error(final ? "Role startup hook failed" : "Role startup hook deferred", { role, hook, attempts, error: message });
      if (!final && !closing && activeRole === role) {
        const timer = setTimeout(() => {
          startupHookRetryTimers.delete(hook);
          void runWithRetry(hook);
        }, STARTUP_HOOK_RETRY_MS[retryIndex]);
        timer.unref();
        startupHookRetryTimers.set(hook, timer);
      }
    }
  };
  for (const hook of resolveRoleTopology(role).startupHooks) {
    startupHookStates.set(hook, { status: "pending", attempts: 0, updatedAt: new Date().toISOString() });
  }
  await Promise.all(resolveRoleTopology(role).startupHooks.map(runWithRetry));
}

export function getAllWorkers(): Worker[] {
  return workers;
}

export function getActiveWorkerRole(): WorkerRole | null {
  return activeRole;
}

export async function startWorkers(role: WorkerRole = "all"): Promise<void> {
  if (closing || closePromise) throw new Error(`Worker role is shutting down; cannot start ${role}`);
  if (activeRole) {
    if (activeRole !== role) throw new Error(`Worker role ${activeRole} is already active; cannot start ${role}`);
    return;
  }
  if (startPromise) {
    if (startPromise.role !== role) throw new Error(`Worker role ${startPromise.role} is starting; cannot start ${role}`);
    return startPromise.promise;
  }

  const promise = (async () => {
    logger.info("Starting worker role", { role });
    try {
      const removed = await reapExpiredLocalScratch();
      if (removed > 0) logger.info("Removed expired local attempt scratch", { removed });
    } catch (error) {
      logger.warn("Local attempt scratch cleanup deferred", { error: error instanceof Error ? error.message : String(error) });
    }

    const constructed = await constructWorkers(role);
    workers = constructed;
    activeRole = role;
    try {
      startValidatedWorkers(role, constructed);
    } catch (error) {
      workers = [];
      activeRole = null;
      await closeConstructed(constructed);
      throw error;
    }

    const ownership = getWorkerOwnership(role);
    logger.info("Worker role ownership validated", {
      role,
      consumers: ownership.registeredConsumers,
      auxiliaryQueueClients: difference(ownership.requiredQueueClients, ownership.expectedConsumers),
      startupHooks: ownership.startupHooks,
    });
    await startRoleHooks(role);
  })();
  startPromise = { role, promise };
  try {
    await promise;
  } finally {
    if (startPromise?.promise === promise) startPromise = null;
  }
}

export async function closeWorkers(): Promise<void> {
  if (closePromise) return closePromise;
  const promise = (async () => {
    const pendingStart = startPromise?.promise;
    closing = true;
    logger.info("Closing worker role", { role: activeRole });
    try {
      // Serialize shutdown behind construction and startup hooks. This prevents
      // a late hook from recreating a timer after shutdown has already stopped it.
      await pendingStart?.catch(() => undefined);
      const [baseWorker, dispatchers, snapshots, opMetrics, cloudflare] = await Promise.all([
        import("./base-worker.js"),
        import("../services/content-stage-dispatcher.js"),
        import("../services/pipeline-lane-snapshot.js"),
        import("./op-metrics-flush.worker.js"),
        import("../services/cloudflare-analytics.service.js"),
      ]);
      dispatchers.stopContentStageDispatchers();
      snapshots.stopPipelineLaneSnapshots();
      opMetrics.stopOpMetricsFlush();
      cloudflare.stopCloudflareAnalyticsPuller();
	  for (const timer of startupHookRetryTimers.values()) clearTimeout(timer);
	  startupHookRetryTimers.clear();
	  startupHookStates.clear();
      const aborted = baseWorker.abortActiveProcessors();
      if (aborted > 0) logger.info("Aborted active processors for shutdown", { count: aborted });

      const activeWorkers = workers;
      workers = [];
      activeRole = null;
      await Promise.all(activeWorkers.map(async (worker) => {
        try {
          await worker.close();
          logger.info("Worker closed", { queue: worker.name });
        } catch (error) {
          logger.error("Error closing worker", { queue: worker.name, error: error instanceof Error ? error.message : String(error) });
        }
      }));
    } finally {
      closing = false;
    }
  })();
  closePromise = promise;
  try {
    await promise;
  } finally {
    if (closePromise === promise) closePromise = null;
  }
}

export async function syncAtomizationSweeper(): Promise<void> { return (await import("./atomization-sweep.worker.js")).syncAtomizationSweeper(); }
export async function syncRepeatableSweepers(): Promise<void> { return (await import("./storage.worker.js")).syncRepeatableSweepers(); }
export async function syncReconcileSweeper(): Promise<void> { return (await import("./reconcile.worker.js")).syncReconcileSweeper(); }
export async function syncDiscoverySweeper(): Promise<void> { return (await import("./discovery-sweep.worker.js")).syncDiscoverySweeper(); }
export async function syncSourceGraphSweeper(): Promise<void> { return (await import("./source-graph.worker.js")).syncSourceGraphSweeper(); }
export async function syncNewsCirculationSweeper(): Promise<void> { return (await import("./news-circulation.worker.js")).syncNewsCirculationSweeper(); }
export async function syncMediaCirculationSweeper(): Promise<void> { return (await import("./media-circulation.worker.js")).syncMediaCirculationSweeper(); }
export async function syncSourceRunDispatchSweeper(): Promise<void> { return (await import("./source-run-dispatch.worker.js")).syncSourceRunDispatchSweeper(); }
export async function syncSourceRunVerificationSweeper(): Promise<void> { return (await import("./source-run-verification.worker.js")).syncSourceRunVerificationSweeper(); }
export async function syncLifecycleReceiptActionSweeper(): Promise<void> { return (await import("./lifecycle-receipt.worker.js")).syncLifecycleReceiptActionSweeper(); }
export async function syncPipelineRepairSweeper(): Promise<void> { return (await import("./pipeline-repair.worker.js")).syncPipelineRepairSweeper(); }

export const workerRegistryTestUtils = {
  setRoleTerminator(terminator: (code: number) => never): () => void {
    const previous = terminateRole;
    terminateRole = terminator;
    return () => { terminateRole = previous; };
  },
};

export { createWorker } from "./base-worker.js";
