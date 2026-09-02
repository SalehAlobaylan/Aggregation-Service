import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { QUEUE_NAMES } from "../../src/queues/schemas.js";
import { resolveRoleTopology, WORKER_DESCRIPTORS, WORKER_ROLES } from "../../src/runtime/role-topology.js";

const mocks = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock("../../src/workers/base-worker.js", () => ({ createWorker: mocks.createWorker }));

const expectedConsumers = {
  "intake-control": [
    QUEUE_NAMES.FETCH, QUEUE_NAMES.NORMALIZE, QUEUE_NAMES.ATOMIZATION_SWEEP,
    QUEUE_NAMES.DISCOVERY, QUEUE_NAMES.DISCOVERY_SWEEP, QUEUE_NAMES.SOURCE_GRAPH,
    QUEUE_NAMES.NEWS_CIRCULATION, QUEUE_NAMES.MEDIA_CIRCULATION,
    QUEUE_NAMES.SOURCE_RUN_DISPATCH, QUEUE_NAMES.SOURCE_RUN_VERIFICATION,
    QUEUE_NAMES.LIFECYCLE_RECEIPTS,
  ],
  news: [QUEUE_NAMES.NEWS_ENRICHMENT, QUEUE_NAMES.NEWS_OPTIONAL],
  "pods-control": [QUEUE_NAMES.PODS_COMPLETION, QUEUE_NAMES.PODS_OPTIONAL, QUEUE_NAMES.PODS_ATOMIZATION],
  "media-executor": [QUEUE_NAMES.MEDIA, QUEUE_NAMES.PODS_MEDIA, QUEUE_NAMES.ATOMIZATION],
  "media-maintenance": [QUEUE_NAMES.STORAGE_SWEEP, QUEUE_NAMES.RECONCILE, QUEUE_NAMES.QUALITY_REENCODE, QUEUE_NAMES.PIPELINE_REPAIR],
  "legacy-drain": [QUEUE_NAMES.AI],
} as const;

describe("worker role topology", () => {
  it("declares the exact consumer queues for every explicit role", () => {
    for (const role of WORKER_ROLES.filter((candidate) => candidate !== "all")) {
      const topology = resolveRoleTopology(role);
      expect(topology.consumerQueues).toEqual(expectedConsumers[role]);
      expect(new Set(topology.consumerQueues).size).toBe(topology.consumerQueues.length);
      expect(topology.consumerQueues.every((queue) => topology.queueClients.includes(queue))).toBe(true);
    }
  });

  it("keeps consumption separate from required producer-only queue clients", () => {
    expect(resolveRoleTopology("intake-control").queueClients).toEqual(expect.arrayContaining([
      QUEUE_NAMES.AI, QUEUE_NAMES.MEDIA, QUEUE_NAMES.ATOMIZATION,
      QUEUE_NAMES.QUALITY_REENCODE, QUEUE_NAMES.STORAGE_SWEEP,
    ]));
    expect(resolveRoleTopology("pods-control").queueClients).toContain(QUEUE_NAMES.ATOMIZATION);
    expect(resolveRoleTopology("pods-control").queueClients).toContain(QUEUE_NAMES.PODS_MEDIA);
    expect(resolveRoleTopology("media-executor").queueClients).toContain(QUEUE_NAMES.AI);
    expect(resolveRoleTopology("media-maintenance").queueClients).toContain(QUEUE_NAMES.AI);
    expect(resolveRoleTopology("legacy-drain").queueClients).toContain(QUEUE_NAMES.ATOMIZATION);
  });

  it("assigns circulation to Intake and maintenance schedules to Maintenance", () => {
    const intake = resolveRoleTopology("intake-control").startupHooks;
    const executor = resolveRoleTopology("media-executor").startupHooks;
    const maintenance = resolveRoleTopology("media-maintenance").startupHooks;
    expect(intake).toEqual(expect.arrayContaining(["news-circulation-sweeper", "media-circulation-sweeper"]));
    expect(executor).not.toContain("news-circulation-sweeper");
    expect(executor).not.toContain("media-circulation-sweeper");
    expect(executor).not.toContain("pods-lane-snapshot");
    expect(maintenance).toEqual(expect.arrayContaining(["storage-sweepers", "reconcile-sweeper", "pipeline-repair-sweeper"]));
    expect(intake).not.toContain("pipeline-repair-sweeper");
    expect(new Set(resolveRoleTopology("all").startupHooks).size).toBe(resolveRoleTopology("all").startupHooks.length);
  });

  it("imports every worker module without constructing a worker", async () => {
    mocks.createWorker.mockClear();
    for (const descriptor of Object.values(WORKER_DESCRIPTORS)) await descriptor.loadFactory();
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("rejects top-level worker, timer, and scheduler construction in worker modules", async () => {
    const workerDir = join(process.cwd(), "src", "workers");
    const filenames = (await readdir(workerDir)).filter((name) => name.endsWith(".worker.ts"));
    const forbiddenCalls = new Set(["createWorker", "setInterval", "setTimeout", "setImmediate"]);
    const violations: string[] = [];

    for (const filename of filenames) {
      const source = await readFile(join(workerDir, filename), "utf8");
      const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      for (const statement of file.statements) {
        if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
          const name = ts.isIdentifier(statement.expression.expression) ? statement.expression.expression.text : "";
          if (forbiddenCalls.has(name)) violations.push(`${filename}:${name}`);
        }
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          const initializer = declaration.initializer;
          if (initializer && ts.isCallExpression(initializer)) {
            const name = ts.isIdentifier(initializer.expression) ? initializer.expression.text : "";
            if (forbiddenCalls.has(name)) violations.push(`${filename}:${name}`);
          }
          if (initializer && ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === "Worker") {
            violations.push(`${filename}:new Worker`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("declares every direct getQueue dependency used by each worker module", async () => {
    const workerIdsByFile: Record<string, Array<keyof typeof WORKER_DESCRIPTORS>> = {
      "ai.worker.ts": ["legacy-ai"],
      "atomization-sweep.worker.ts": ["atomization-sweep"],
      "atomization.worker.ts": ["atomization"],
      "content-stage-atomization.worker.ts": ["pods-atomization-stage"],
      "discovery-sweep.worker.ts": ["discovery-sweep"],
      "fetch.worker.ts": ["fetch"],
      "lifecycle-receipt.worker.ts": ["lifecycle-receipt"],
      "media-circulation.worker.ts": ["media-circulation"],
      "media.worker.ts": ["legacy-media", "pods-media"],
      "news-circulation.worker.ts": ["news-circulation"],
      "normalize.worker.ts": ["normalize"],
      "pipeline-repair.worker.ts": ["pipeline-repair"],
      "quality.worker.ts": ["quality"],
      "reconcile.worker.ts": ["reconcile"],
      "source-graph.worker.ts": ["source-graph"],
      "source-run-dispatch.worker.ts": ["source-run-dispatch"],
      "source-run-verification.worker.ts": ["source-run-verification"],
      "storage.worker.ts": ["storage"],
    };
    const workerDir = join(process.cwd(), "src", "workers");
    const missing: string[] = [];
    for (const [filename, workerIds] of Object.entries(workerIdsByFile)) {
      const source = await readFile(join(workerDir, filename), "utf8");
      const directDependencies = [...source.matchAll(/getQueue\(QUEUE_NAMES\.([A-Z_]+)/g)]
        .map((match) => QUEUE_NAMES[match[1] as keyof typeof QUEUE_NAMES])
        .filter(Boolean);
      const declared = new Set(workerIds.flatMap((workerId) => WORKER_DESCRIPTORS[workerId].queueClients));
      for (const queueName of directDependencies) {
        if (!declared.has(queueName)) missing.push(`${filename}:${queueName}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
