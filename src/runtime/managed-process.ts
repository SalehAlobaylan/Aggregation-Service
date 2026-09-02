/**
 * One lifecycle owner for external media commands.  Each command gets its own
 * process group so aborting a BullMQ attempt cannot leave yt-dlp's ffmpeg (or
 * another descendant) running after its owner has exited.
 */
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "child_process";
import { readFile } from "fs/promises";
import {
  managedChildren,
  managedProcessTerminations,
} from "../observability/metrics.js";

export interface ManagedProcessOptions {
  label: string;
  args: string[];
  timeoutMs: number;
  /** Fail a media command that remains alive but emits no progress. */
  noProgressTimeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  /** Return true only when the chunk contains real work progress. */
  onProgress?: (chunk: Buffer, stream: "stdout" | "stderr") => boolean | void;
  onMetrics?: (metrics: ManagedProcessMetrics) => void;
}

export interface ManagedProcessMetrics {
  pid: number;
  elapsedMs: number;
  cpuMs?: number;
  rssBytes?: number;
  readBytes?: number;
  writeBytes?: number;
  encodedMediaTimeSec?: number;
  speed?: number;
  outputBytes?: number;
  lastProgressAgeMs: number;
}

export interface ManagedProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const active = new Map<
  number,
  { label: string; process: ChildProcessWithoutNullStreams }
>();
const latestMetrics = new Map<number, ManagedProcessMetrics>();

export function activeManagedProcesses(): Array<{
  pid: number;
  label: string;
}> {
  return [...active.entries()].map(([pid, entry]) => ({
    pid,
    label: entry.label,
  }));
}

/** Bounded diagnostics for currently managed children. Command arguments,
 * URLs, and media payloads are intentionally not retained. */
export function activeManagedProcessMetrics(): ManagedProcessMetrics[] {
  return [...active.keys()]
    .map((pid) => latestMetrics.get(pid))
    .filter((value): value is ManagedProcessMetrics => value !== undefined);
}

function abortError(label: string, reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(`${label} aborted`);
}

function terminateTree(
  child: ChildProcessWithoutNullStreams,
  label: string,
  force = false,
): void {
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  const pid = child.pid;
  if (!pid) return;
  try {
    // `detached` creates a POSIX process group. Negative PID targets every
    // descendant (not just yt-dlp's wrapper process).
    if (process.platform !== "win32") process.kill(-pid, signal);
    else child.kill(signal);
    managedProcessTerminations.labels(label, force ? "kill" : "term").inc();
  } catch (error: unknown) {
    // ESRCH is success: the child/group already exited.
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ))
      throw error;
  }
}

function processGroupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code !== "ESRCH");
  }
}

async function waitForProcessGroupGone(child: ChildProcessWithoutNullStreams, label: string): Promise<void> {
  const pid = child.pid;
  if (!pid || process.platform === "win32") return;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!processGroupAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  terminateTree(child, label, true);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!processGroupAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} process group did not terminate`);
}

function meaningfulProgress(chunk: Buffer): { mediaTime?: number; frame?: number; speed?: number; outputBytes?: number } | undefined {
  const value = chunk.toString();
  // FFmpeg progress is normally on stderr; yt-dlp's download meter is on
  // stdout/stderr. Ordinary banners and warnings deliberately do not count.
  const time = value.match(/(?:out_time|time)=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const frame = value.match(/\bframe=\s*(\d+)/);
  const speed = value.match(/speed=\s*([0-9.]+)x/);
  const size = value.match(/(?:total_size|size)=\s*([0-9.]+)\s*(MiB|MB|KiB|kB|bytes|B)?/i);
  if (!time && !frame && !size) return undefined;
  const unit = size?.[2]?.toLowerCase();
  const multiplier = unit === "kb" ? 1_000
    : unit === "kib" ? 1_024
      : unit === "mb" ? 1_000_000
        : unit === "mib" ? 1_048_576
          : 1;
  return {
    mediaTime: time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : undefined,
    frame: frame ? Number(frame[1]) : undefined,
    speed: speed ? Number(speed[1]) : undefined,
    outputBytes: size ? Math.floor(Number(size[1]) * multiplier) : undefined,
  };
}

async function linuxChildMetrics(pid: number): Promise<Partial<ManagedProcessMetrics>> {
  if (process.platform !== "linux") return {};
  try {
    const [stat, io] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/io`, "utf8"),
    ]);
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const pageSize = 4096;
    const rssPages = Number(fields[21]);
    const ticks = Number(fields[11]) + Number(fields[12]);
    const read = io.match(/read_bytes:\s+(\d+)/)?.[1];
    const written = io.match(/write_bytes:\s+(\d+)/)?.[1];
    return {
      cpuMs: Number.isFinite(ticks) ? (ticks / 100) * 1000 : undefined,
      rssBytes: Number.isFinite(rssPages) ? rssPages * pageSize : undefined,
      readBytes: read ? Number(read) : undefined,
      writeBytes: written ? Number(written) : undefined,
    };
  } catch {
    return {};
  }
}

export async function runManagedProcess(
  options: ManagedProcessOptions,
): Promise<ManagedProcessResult> {
  if (options.signal?.aborted)
    throw abortError(options.label, options.signal.reason);
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  };
  const child = spawn(
    options.label,
    options.args,
    spawnOptions,
  ) as ChildProcessWithoutNullStreams;
  if (!child.pid)
    throw new Error(`${options.label} did not return a process id`);
  active.set(child.pid, { label: options.label, process: child });
  managedChildren.labels(options.label).inc();

  let timeout: NodeJS.Timeout | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let noProgress: NodeJS.Timeout | undefined;
  let aborted = false;
  let stopReason: unknown;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let encodedMediaTimeSec: number | undefined;
  let encodedFrames: number | undefined;
  let speed: number | undefined;
  let outputBytes: number | undefined;
  let metricsTimer: NodeJS.Timeout | undefined;
  const stop = (reason: unknown) => {
    if (aborted) return;
    aborted = true;
    stopReason = reason;
    terminateTree(child, options.label);
    escalation = setTimeout(
      () => terminateTree(child, options.label, true),
      5_000,
    );
    escalation.unref();
    void reason;
  };
  const onAbort = () => stop(options.signal?.reason);

  try {
    return await new Promise<ManagedProcessResult>((resolve, reject) => {
      child.once("error", (error) => stop(error));
      child.once("close", async (code, signal) => {
        if (metricsTimer) clearInterval(metricsTimer);
        latestMetrics.delete(child.pid!);
        await waitForProcessGroupGone(child, options.label).catch((error) => {
          if (!aborted) { aborted = true; stopReason = error; }
        });
        if (aborted) {
          reject(
            abortError(options.label, stopReason ?? options.signal?.reason),
          );
          return;
        }
        resolve({ code, signal });
      });
      const refreshProgress = () => {
        if (!options.noProgressTimeoutMs) return;
        if (noProgress) clearTimeout(noProgress);
        noProgress = setTimeout(
          () =>
            stop(
              new Error(
                `${options.label} produced no progress for ${options.noProgressTimeoutMs}ms`,
              ),
            ),
          options.noProgressTimeoutMs,
        );
        noProgress.unref();
      };
      const recordProgress = (chunk: Buffer, stream: "stdout" | "stderr") => {
        const parsed = meaningfulProgress(chunk);
        const explicitlyMeaningful = options.onProgress?.(chunk, stream) === true;
        const parsedMeaningful = Boolean(parsed && (
          (parsed.mediaTime != null && parsed.mediaTime > (encodedMediaTimeSec ?? -1)) ||
          (parsed.frame != null && parsed.frame > (encodedFrames ?? -1)) ||
          (parsed.outputBytes != null && parsed.outputBytes > (outputBytes ?? -1))
        ));
        if (!parsedMeaningful && !explicitlyMeaningful) return;
        lastProgressAt = Date.now();
        if (parsed?.mediaTime != null) encodedMediaTimeSec = Math.max(encodedMediaTimeSec ?? 0, parsed.mediaTime);
        if (parsed?.frame != null) encodedFrames = Math.max(encodedFrames ?? 0, parsed.frame);
        if (parsed?.speed != null) speed = parsed.speed;
        if (parsed?.outputBytes != null) outputBytes = Math.max(outputBytes ?? 0, parsed.outputBytes);
        refreshProgress();
      };
      child.stdout.on("data", (chunk: Buffer) => {
        recordProgress(chunk, "stdout");
        options.onStdout?.(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        recordProgress(chunk, "stderr");
        options.onStderr?.(chunk);
      });
      {
        const report = async () => {
          const childMetrics = await linuxChildMetrics(child.pid!);
          const metrics = {
            pid: child.pid!, elapsedMs: Date.now() - startedAt, ...childMetrics,
            encodedMediaTimeSec, speed, outputBytes,
            lastProgressAgeMs: Date.now() - lastProgressAt,
          } satisfies ManagedProcessMetrics;
          latestMetrics.set(child.pid!, metrics);
          options.onMetrics?.(metrics);
        };
        metricsTimer = setInterval(() => void report(), 1000);
        metricsTimer.unref();
        void report();
      }
      timeout = setTimeout(
        () =>
          stop(
            new Error(
              `${options.label} timed out after ${options.timeoutMs}ms`,
            ),
          ),
        options.timeoutMs,
      );
      timeout.unref();
      if (options.noProgressTimeoutMs) refreshProgress();
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (escalation) clearTimeout(escalation);
    if (noProgress) clearTimeout(noProgress);
    if (metricsTimer) clearInterval(metricsTimer);
    await waitForProcessGroupGone(child, options.label).catch(() => undefined);
    options.signal?.removeEventListener("abort", onAbort);
    if (child.pid) latestMetrics.delete(child.pid);
    active.delete(child.pid);
    managedChildren.labels(options.label).dec();
  }
}

/** Terminate every child owned by this Aggregation role during shutdown. */
export async function terminateManagedProcesses(): Promise<void> {
  const children = [...active.values()];
  for (const entry of children) terminateTree(entry.process, entry.label);
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const entry of children) {
    if (entry.process.pid && processGroupAlive(entry.process.pid)) {
      terminateTree(entry.process, entry.label, true);
    }
  }
  await Promise.all(children.map((entry) => waitForProcessGroupGone(entry.process, entry.label)));
}
