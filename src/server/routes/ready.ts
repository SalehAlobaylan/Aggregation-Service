/** Role-local readiness. This endpoint never claims to represent another process. */
import type { FastifyInstance } from "fastify";
import { config } from "../../config/index.js";
import { logger } from "../../observability/logger.js";
import { localRoleReadiness, type LocalRoleReadiness } from "../../runtime/role-readiness.js";

type StorageStatus = "configured" | "reachable" | "unreachable";
type ReadyResponse = LocalRoleReadiness & {
  status: "ready" | "not_ready";
  dependencies: LocalRoleReadiness["dependencies"] & { storage: StorageStatus };
};

async function storageReadiness(): Promise<StorageStatus> {
  if (!config.storageEndpoint) return "configured";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    // Any HTTP response proves network reachability. Private S3-compatible
    // endpoints commonly reject an unsigned root HEAD with 400/401/403.
    await fetch(config.storageEndpoint, { method: "HEAD", signal: controller.signal });
    return "reachable";
  } catch (error) {
    logger.debug("Storage check failed during readiness check", { error });
    return "unreachable";
  } finally {
    clearTimeout(timeout);
  }
}

export async function readyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Reply: ReadyResponse }>("/ready", async (_request, reply) => {
    const [local, storage] = await Promise.all([localRoleReadiness(), storageReadiness()]);
    const body: ReadyResponse = {
      ...local,
      status: local.pod_ready ? "ready" : "not_ready",
      dependencies: { ...local.dependencies, storage },
    };
    return reply.status(local.pod_ready ? 200 : 503).send(body);
  });
}
