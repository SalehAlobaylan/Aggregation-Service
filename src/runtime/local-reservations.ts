import { mkdir, readdir, readFile, rm, statfs, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { getRedisConnection } from "../queues/redis.js";
import { config } from "../config/index.js";
import { ResourceDeferredError } from "./resource-admission.js";

const RESERVATION_TTL_MS = 90_000;
const SAFETY_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;

export class LocalReservationDeferredError extends ResourceDeferredError {
  constructor(readonly requestedBytes: number) {
    super("download_io");
    this.name = "LocalReservationDeferredError";
  }
}

export interface LocalReservation {
  id: string;
  attemptId: string;
  root: string;
  sourceDir: string;
  outputDir: string;
  hlsDir: string;
  metadataDir: string;
  heartbeat(): Promise<boolean>;
  release(): Promise<void>;
}

export interface LocalReservationMetadata {
  contentId?: string;
  resourceDomainId?: string;
  ownerRole?: string;
}

const ACQUIRE = `
local total = tonumber(redis.call('GET', KEYS[1]) or '0')
local requested = tonumber(ARGV[1])
local available = tonumber(ARGV[2])
if redis.call('EXISTS', KEYS[3]) == 1 then return {0, total} end
if total + requested > available then return {0, total} end
redis.call('INCRBY', KEYS[1], requested)
redis.call('SET', KEYS[2], requested, 'PX', ARGV[3])
redis.call('SET', KEYS[3], ARGV[4], 'PX', ARGV[3])
redis.call('PEXPIRE', KEYS[1], 120000)
return {1, total}
`;
const RELEASE = `
local amount = tonumber(redis.call('GET', KEYS[2]) or '0')
if amount then
  local total = tonumber(redis.call('GET', KEYS[1]) or '0')
  local remaining = math.max(0, total - amount)
  if remaining == 0 then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], remaining, 'PX', 120000) end
end
redis.call('DEL', KEYS[2])
if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('DEL', KEYS[3]) end
return 1
`;
const HEARTBEAT = `
if redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
if redis.call('GET', KEYS[3]) ~= ARGV[2] then return 0 end
redis.call('PEXPIRE', KEYS[1], 120000)
redis.call('PEXPIRE', KEYS[2], ARGV[1])
redis.call('PEXPIRE', KEYS[3], ARGV[1])
return 1
`;

function reservationKey(id: string): string {
  return `wahb:resource:${process.env.RESOURCE_DOMAIN?.trim() || "local"}:scratch:${id}`;
}
function totalKey(): string {
  return `wahb:resource:${process.env.RESOURCE_DOMAIN?.trim() || "local"}:scratch:total`;
}
function attemptKey(attemptId: string): string {
  return `wahb:resource:${process.env.RESOURCE_DOMAIN?.trim() || "local"}:scratch:attempt:${attemptId}`;
}

async function availableBytes(root: string): Promise<number> {
  const fs = await statfs(root);
  return Math.max(
    0,
    Number(fs.bavail) * Number(fs.bsize) - SAFETY_RESERVE_BYTES,
  );
}

export async function reserveLocalScratch(
  attemptId: string,
  requestedBytes: number,
  metadata: LocalReservationMetadata = {},
): Promise<LocalReservation> {
  const safeAttempt = attemptId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const root = resolve(config.mediaTempDir, "attempts", safeAttempt);
  const attemptsRoot = resolve(config.mediaTempDir, "attempts");
  await mkdir(attemptsRoot, { recursive: true });
  const id = `${process.pid}:${randomUUID()}`;
  const redis = getRedisConnection();
  const available = await availableBytes(attemptsRoot);
  const reservationKeyValue = reservationKey(id);
  const result = (await redis.eval(
    ACQUIRE,
    3,
    totalKey(),
    reservationKeyValue,
    attemptKey(safeAttempt),
    Math.max(1, Math.ceil(requestedBytes)),
    Math.max(0, Math.floor(available)),
    RESERVATION_TTL_MS,
    id,
  )) as [number, number];
  if (Number(result?.[0]) !== 1)
    throw new LocalReservationDeferredError(requestedBytes);
  const sourceDir = join(root, "source");
  const outputDir = join(root, "output");
  const hlsDir = join(root, "hls");
  const metadataDir = join(root, "metadata");
  try {
    await Promise.all(
      [sourceDir, outputDir, hlsDir, metadataDir].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    await writeFile(
      join(root, ".reservation.json"),
      JSON.stringify({
        attempt_id: safeAttempt,
        resource_domain_id:
          metadata.resourceDomainId ??
          process.env.RESOURCE_DOMAIN?.trim() ??
          "local",
        content_id: metadata.contentId,
        expected_bytes: Math.max(1, Math.ceil(requestedBytes)),
        current_free_bytes: Math.max(0, Math.floor(available)),
        already_reserved_bytes: Number(result?.[1] ?? 0),
        safety_reserve_bytes: SAFETY_RESERVE_BYTES,
        owner_role:
          metadata.ownerRole ?? process.env.ROLE?.trim() ?? "aggregation",
        process_id: process.pid,
        created_at: new Date().toISOString(),
      }),
      "utf8",
    );
  } catch (error) {
    await redis.eval(RELEASE, 3, totalKey(), reservationKeyValue, attemptKey(safeAttempt), id).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const metaKey = `${reservationKeyValue}:meta`;
  await redis.hset(metaKey, {
    attempt_id: safeAttempt,
    content_id: metadata.contentId ?? "",
    resource_domain_id:
      metadata.resourceDomainId ??
      process.env.RESOURCE_DOMAIN?.trim() ??
      "local",
    expected_bytes: String(Math.max(1, Math.ceil(requestedBytes))),
    current_free_bytes: String(Math.max(0, Math.floor(available))),
    already_reserved_bytes: String(Number(result?.[1] ?? 0)),
    owner_role: metadata.ownerRole ?? process.env.ROLE?.trim() ?? "aggregation",
    process_id: String(process.pid),
  });
  await redis.pexpire(metaKey, RESERVATION_TTL_MS);
  let released = false;
  return {
    id,
    attemptId: safeAttempt,
    root,
    sourceDir,
    outputDir,
    hlsDir,
    metadataDir,
    async heartbeat(): Promise<boolean> {
      if (released) return false;
      await redis.pexpire(metaKey, RESERVATION_TTL_MS);
      return Number(await redis.eval(
        HEARTBEAT,
        3,
        totalKey(),
        reservationKeyValue,
        attemptKey(safeAttempt),
        RESERVATION_TTL_MS,
        id,
      )) === 1;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await redis.eval(RELEASE, 3, totalKey(), reservationKeyValue, attemptKey(safeAttempt), id);
      await redis.del(metaKey);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function reapExpiredLocalScratch(): Promise<number> {
  const attempts = resolve(config.mediaTempDir, "attempts");
  await mkdir(attempts, { recursive: true });
  const redis = getRedisConnection();
  let removed = 0;
  for (const entry of await readdir(attempts, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const attempt = entry.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const marker = `wahb:resource:${process.env.RESOURCE_DOMAIN?.trim() || "local"}:scratch:attempt:${attempt}`;
    if (await redis.exists(marker)) continue;
    let reservation: { process_id?: number };
    try {
      reservation = JSON.parse(
        await readFile(join(attempts, entry.name, ".reservation.json"), "utf8"),
      ) as { process_id?: number };
    } catch {
      // Unknown/legacy directories are never safe for automatic deletion.
      continue;
    }
    if (reservation.process_id && isProcessAlive(reservation.process_id))
      continue;
    // Only remove directories whose lease is absent and whose owner process
    // is gone. Older deterministic paths are deliberately not touched.
    if (!/^[-a-zA-Z0-9_]+$/.test(entry.name)) continue;
    await rm(join(attempts, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
