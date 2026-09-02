import type { Worker } from "bullmq";
import { createHash } from "node:crypto";
import { QUEUE_NAMES, type QueueName } from "../queues/schemas.js";

export const WORKER_ROLES = [
  "all",
  "intake-control",
  "news",
  "pods-control",
  "media-executor",
  "media-maintenance",
  "legacy-drain",
] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];

export const EXPLICIT_WORKER_ROLES = WORKER_ROLES.filter(
  (role): role is Exclude<WorkerRole, "all"> => role !== "all",
);
export const CORE_WORKER_ROLES = EXPLICIT_WORKER_ROLES.filter((role) => role !== "legacy-drain");
export const ROLE_TOPOLOGY_SCHEMA_VERSION = "aggregation-role-topology/v1";

export type WorkerId =
  | "fetch"
  | "normalize"
  | "atomization-sweep"
  | "discovery"
  | "discovery-sweep"
  | "source-graph"
  | "news-circulation"
  | "media-circulation"
  | "source-run-dispatch"
  | "source-run-verification"
  | "lifecycle-receipt"
  | "news-enrichment"
  | "news-optional"
  | "pods-completion"
  | "pods-optional"
  | "pods-atomization-stage"
  | "legacy-media"
  | "pods-media"
  | "atomization"
  | "storage"
  | "reconcile"
  | "quality"
  | "pipeline-repair"
  | "legacy-ai";

export type StartupHookId =
  | "news-dispatcher"
  | "pods-control-dispatcher"
  | "pods-media-dispatcher"
  | "news-lane-snapshot"
  | "pods-lane-snapshot"
  | "atomization-sweeper"
  | "storage-sweepers"
  | "reconcile-sweeper"
  | "discovery-sweeper"
  | "source-graph-sweeper"
  | "news-circulation-sweeper"
  | "media-circulation-sweeper"
  | "source-run-dispatch-sweeper"
  | "source-run-verification-sweeper"
  | "lifecycle-receipt-sweeper"
  | "pipeline-repair-sweeper"
  | "legacy-media-priority-repair"
  | "op-metrics-flush"
  | "cloudflare-analytics";

type WorkerFactory = () => Worker;

interface WorkerDescriptor {
  queueName: QueueName;
  queueClients: readonly QueueName[];
  loadFactory: () => Promise<WorkerFactory>;
}

const defaultDlq = [QUEUE_NAMES.DLQ] as const;
const newsDlq = [QUEUE_NAMES.NEWS_STAGE_DLQ] as const;
const podsDlq = [QUEUE_NAMES.PODS_STAGE_DLQ] as const;

export const WORKER_DESCRIPTORS: Record<WorkerId, WorkerDescriptor> = {
  fetch: {
    queueName: QUEUE_NAMES.FETCH,
    queueClients: [QUEUE_NAMES.FETCH, QUEUE_NAMES.NORMALIZE, ...defaultDlq],
    loadFactory: async () => (await import("../workers/fetch.worker.js")).createFetchWorker,
  },
  normalize: {
    queueName: QUEUE_NAMES.NORMALIZE,
    queueClients: [QUEUE_NAMES.NORMALIZE, QUEUE_NAMES.AI, QUEUE_NAMES.MEDIA, QUEUE_NAMES.ATOMIZATION, ...defaultDlq],
    loadFactory: async () => (await import("../workers/normalize.worker.js")).createNormalizeWorker,
  },
  "atomization-sweep": {
    queueName: QUEUE_NAMES.ATOMIZATION_SWEEP,
    queueClients: [QUEUE_NAMES.ATOMIZATION_SWEEP, QUEUE_NAMES.ATOMIZATION, ...defaultDlq],
    loadFactory: async () => (await import("../workers/atomization-sweep.worker.js")).createAtomizationSweepWorker,
  },
  discovery: {
    queueName: QUEUE_NAMES.DISCOVERY,
    queueClients: [QUEUE_NAMES.DISCOVERY, ...defaultDlq],
    loadFactory: async () => (await import("../workers/discovery.worker.js")).createDiscoveryWorker,
  },
  "discovery-sweep": {
    queueName: QUEUE_NAMES.DISCOVERY_SWEEP,
    queueClients: [QUEUE_NAMES.DISCOVERY_SWEEP, QUEUE_NAMES.DISCOVERY, ...defaultDlq],
    loadFactory: async () => (await import("../workers/discovery-sweep.worker.js")).createDiscoverySweepWorker,
  },
  "source-graph": {
    queueName: QUEUE_NAMES.SOURCE_GRAPH,
    queueClients: [QUEUE_NAMES.SOURCE_GRAPH, ...defaultDlq],
    loadFactory: async () => (await import("../workers/source-graph.worker.js")).createSourceGraphWorker,
  },
  "news-circulation": {
    queueName: QUEUE_NAMES.NEWS_CIRCULATION,
    queueClients: [QUEUE_NAMES.NEWS_CIRCULATION, QUEUE_NAMES.FETCH, ...defaultDlq],
    loadFactory: async () => (await import("../workers/news-circulation.worker.js")).createNewsCirculationWorker,
  },
  "media-circulation": {
    queueName: QUEUE_NAMES.MEDIA_CIRCULATION,
    queueClients: [QUEUE_NAMES.MEDIA_CIRCULATION, QUEUE_NAMES.FETCH, ...defaultDlq],
    loadFactory: async () => (await import("../workers/media-circulation.worker.js")).createMediaCirculationWorker,
  },
  "source-run-dispatch": {
    queueName: QUEUE_NAMES.SOURCE_RUN_DISPATCH,
    queueClients: [QUEUE_NAMES.SOURCE_RUN_DISPATCH, QUEUE_NAMES.FETCH, ...defaultDlq],
    loadFactory: async () => (await import("../workers/source-run-dispatch.worker.js")).createSourceRunDispatchWorker,
  },
  "source-run-verification": {
    queueName: QUEUE_NAMES.SOURCE_RUN_VERIFICATION,
    queueClients: [QUEUE_NAMES.SOURCE_RUN_VERIFICATION, ...defaultDlq],
    loadFactory: async () => (await import("../workers/source-run-verification.worker.js")).createSourceRunVerificationWorker,
  },
  "lifecycle-receipt": {
    queueName: QUEUE_NAMES.LIFECYCLE_RECEIPTS,
    queueClients: [QUEUE_NAMES.LIFECYCLE_RECEIPTS, ...defaultDlq],
    loadFactory: async () => (await import("../workers/lifecycle-receipt.worker.js")).createLifecycleReceiptWorker,
  },
  "news-enrichment": {
    queueName: QUEUE_NAMES.NEWS_ENRICHMENT,
    queueClients: [QUEUE_NAMES.NEWS_ENRICHMENT, ...newsDlq],
    loadFactory: async () => (await import("../workers/content-stage-embedding.worker.js")).createNewsEnrichmentWorker,
  },
  "news-optional": {
    queueName: QUEUE_NAMES.NEWS_OPTIONAL,
    queueClients: [QUEUE_NAMES.NEWS_OPTIONAL, ...newsDlq],
    loadFactory: async () => (await import("../workers/content-stage-embedding.worker.js")).createNewsOptionalWorker,
  },
  "pods-completion": {
    queueName: QUEUE_NAMES.PODS_COMPLETION,
    queueClients: [QUEUE_NAMES.PODS_COMPLETION, ...podsDlq],
    loadFactory: async () => (await import("../workers/content-stage-embedding.worker.js")).createPodsCompletionWorker,
  },
  "pods-optional": {
    queueName: QUEUE_NAMES.PODS_OPTIONAL,
    queueClients: [QUEUE_NAMES.PODS_OPTIONAL, ...podsDlq],
    loadFactory: async () => (await import("../workers/content-stage-embedding.worker.js")).createPodsOptionalWorker,
  },
  "pods-atomization-stage": {
    queueName: QUEUE_NAMES.PODS_ATOMIZATION,
    queueClients: [QUEUE_NAMES.PODS_ATOMIZATION, QUEUE_NAMES.ATOMIZATION, ...podsDlq],
    loadFactory: async () => (await import("../workers/content-stage-atomization.worker.js")).createPodsAtomizationStageWorker,
  },
  "legacy-media": {
    queueName: QUEUE_NAMES.MEDIA,
    queueClients: [QUEUE_NAMES.MEDIA, QUEUE_NAMES.AI, ...defaultDlq],
    loadFactory: async () => (await import("../workers/media.worker.js")).createLegacyMediaWorker,
  },
  "pods-media": {
    queueName: QUEUE_NAMES.PODS_MEDIA,
    queueClients: [QUEUE_NAMES.PODS_MEDIA, ...podsDlq],
    loadFactory: async () => (await import("../workers/media.worker.js")).createPodsMediaWorker,
  },
  atomization: {
    queueName: QUEUE_NAMES.ATOMIZATION,
    queueClients: [QUEUE_NAMES.ATOMIZATION, QUEUE_NAMES.AI, ...defaultDlq],
    loadFactory: async () => (await import("../workers/atomization.worker.js")).createAtomizationWorker,
  },
  storage: {
    queueName: QUEUE_NAMES.STORAGE_SWEEP,
    queueClients: [QUEUE_NAMES.STORAGE_SWEEP, QUEUE_NAMES.QUALITY_REENCODE, ...defaultDlq],
    loadFactory: async () => (await import("../workers/storage.worker.js")).createStorageWorker,
  },
  reconcile: {
    queueName: QUEUE_NAMES.RECONCILE,
    queueClients: [QUEUE_NAMES.RECONCILE, QUEUE_NAMES.AI, ...defaultDlq],
    loadFactory: async () => (await import("../workers/reconcile.worker.js")).createReconcileWorker,
  },
  quality: {
    queueName: QUEUE_NAMES.QUALITY_REENCODE,
    queueClients: [QUEUE_NAMES.QUALITY_REENCODE, ...defaultDlq],
    loadFactory: async () => (await import("../workers/quality.worker.js")).createQualityWorker,
  },
  "pipeline-repair": {
    queueName: QUEUE_NAMES.PIPELINE_REPAIR,
    queueClients: [QUEUE_NAMES.PIPELINE_REPAIR, ...defaultDlq],
    loadFactory: async () => (await import("../workers/pipeline-repair.worker.js")).createPipelineRepairWorker,
  },
  "legacy-ai": {
    queueName: QUEUE_NAMES.AI,
    queueClients: [QUEUE_NAMES.AI, QUEUE_NAMES.ATOMIZATION, ...defaultDlq],
    loadFactory: async () => (await import("../workers/ai.worker.js")).createLegacyAIWorker,
  },
};

const intakeWorkers: readonly WorkerId[] = [
  "fetch", "normalize", "atomization-sweep", "discovery", "discovery-sweep",
  "source-graph", "news-circulation", "media-circulation", "source-run-dispatch",
  "source-run-verification", "lifecycle-receipt",
];
const newsWorkers: readonly WorkerId[] = ["news-enrichment", "news-optional"];
const podsControlWorkers: readonly WorkerId[] = ["pods-completion", "pods-optional", "pods-atomization-stage"];
const mediaExecutorWorkers: readonly WorkerId[] = ["legacy-media", "pods-media", "atomization"];
const mediaMaintenanceWorkers: readonly WorkerId[] = ["storage", "reconcile", "quality", "pipeline-repair"];
const legacyDrainWorkers: readonly WorkerId[] = ["legacy-ai"];
const allWorkers: readonly WorkerId[] = [
  ...intakeWorkers,
  ...newsWorkers,
  ...podsControlWorkers,
  ...mediaExecutorWorkers,
  ...mediaMaintenanceWorkers,
  ...legacyDrainWorkers,
];

interface RoleDefinition {
  workerIds: readonly WorkerId[];
  extraQueueClients: readonly QueueName[];
  startupHooks: readonly StartupHookId[];
}

const intakeHooks: readonly StartupHookId[] = [
  "atomization-sweeper", "discovery-sweeper", "source-graph-sweeper",
  "news-circulation-sweeper", "media-circulation-sweeper",
  "source-run-dispatch-sweeper", "source-run-verification-sweeper",
  "lifecycle-receipt-sweeper", "op-metrics-flush", "cloudflare-analytics",
];
const newsHooks: readonly StartupHookId[] = ["news-dispatcher", "news-lane-snapshot", "op-metrics-flush"];
const podsControlHooks: readonly StartupHookId[] = ["pods-control-dispatcher", "pods-lane-snapshot", "op-metrics-flush"];
const mediaExecutorHooks: readonly StartupHookId[] = ["pods-media-dispatcher", "op-metrics-flush"];
const maintenanceHooks: readonly StartupHookId[] = ["storage-sweepers", "reconcile-sweeper", "pipeline-repair-sweeper", "op-metrics-flush"];

const ROLE_DEFINITIONS: Record<WorkerRole, RoleDefinition> = {
  "intake-control": {
    workerIds: intakeWorkers,
    // The advertised control process also serves existing queue-backed admin
    // and internal handoffs without consuming the destination queues.
    extraQueueClients: [QUEUE_NAMES.AI, QUEUE_NAMES.MEDIA, QUEUE_NAMES.ATOMIZATION, QUEUE_NAMES.QUALITY_REENCODE, QUEUE_NAMES.STORAGE_SWEEP],
    startupHooks: intakeHooks,
  },
  news: { workerIds: newsWorkers, extraQueueClients: [], startupHooks: newsHooks },
  // Pods Control is the sole writer of the aggregate Pods lane snapshot. Its
  // PODS_MEDIA client is read-only queue telemetry; Media Executor remains the
  // only consumer of that queue.
  "pods-control": { workerIds: podsControlWorkers, extraQueueClients: [QUEUE_NAMES.ATOMIZATION, QUEUE_NAMES.PODS_MEDIA], startupHooks: podsControlHooks },
  "media-executor": { workerIds: mediaExecutorWorkers, extraQueueClients: [QUEUE_NAMES.AI], startupHooks: mediaExecutorHooks },
  "media-maintenance": { workerIds: mediaMaintenanceWorkers, extraQueueClients: [QUEUE_NAMES.AI], startupHooks: maintenanceHooks },
  "legacy-drain": { workerIds: legacyDrainWorkers, extraQueueClients: [QUEUE_NAMES.ATOMIZATION], startupHooks: ["legacy-media-priority-repair", "op-metrics-flush"] },
  all: {
    workerIds: allWorkers,
    extraQueueClients: Object.values(QUEUE_NAMES),
    startupHooks: [...new Set<StartupHookId>([
      ...intakeHooks,
      ...newsHooks,
      ...podsControlHooks,
      ...mediaExecutorHooks,
      ...maintenanceHooks,
      "legacy-media-priority-repair",
    ])],
  },
};

export interface ResolvedRoleTopology {
  role: WorkerRole;
  workerIds: readonly WorkerId[];
  consumerQueues: readonly QueueName[];
  queueClients: readonly QueueName[];
  startupHooks: readonly StartupHookId[];
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

export function resolveRoleTopology(role: WorkerRole): ResolvedRoleTopology {
  const definition = ROLE_DEFINITIONS[role];
  for (const workerId of definition.workerIds) {
    const descriptor = WORKER_DESCRIPTORS[workerId];
    if (!descriptor.queueClients.includes(descriptor.queueName)) {
      throw new Error(`Invalid ${role} topology: ${workerId} does not declare its consumer queue client ${descriptor.queueName}`);
    }
  }
  const consumerQueues = definition.workerIds.map((id) => WORKER_DESCRIPTORS[id].queueName);
  const queueClients = unique([
    ...definition.workerIds.flatMap((id) => WORKER_DESCRIPTORS[id].queueClients),
    ...definition.extraQueueClients,
  ]);
  const duplicateWorkerIds = definition.workerIds.filter((id, index) => definition.workerIds.indexOf(id) !== index);
  const duplicateConsumers = consumerQueues.filter((queue, index) => consumerQueues.indexOf(queue) !== index);
  if (duplicateWorkerIds.length > 0 || duplicateConsumers.length > 0) {
    throw new Error(`Invalid ${role} topology: duplicate workers=${unique(duplicateWorkerIds).join(",")}; duplicate consumers=${unique(duplicateConsumers).join(",")}`);
  }
  for (const queueName of consumerQueues) {
    if (!queueClients.includes(queueName)) throw new Error(`Invalid ${role} topology: missing queue client for ${queueName}`);
  }
  return {
    role,
    workerIds: [...definition.workerIds],
    consumerQueues,
    queueClients,
    startupHooks: unique(definition.startupHooks),
  };
}

/**
 * A deployment-wide digest. A rolling replica with an older ownership
 * contract cannot satisfy a role expected by this binary merely because its
 * role label happens to match.
 */
export function roleTopologyDigest(): string {
  const contract = Object.fromEntries(WORKER_ROLES.map((role) => {
    const topology = resolveRoleTopology(role);
    return [role, {
      consumers: topology.consumerQueues,
      queue_clients: topology.queueClients,
      startup_hooks: topology.startupHooks,
    }];
  }));
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}
