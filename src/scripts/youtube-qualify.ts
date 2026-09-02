/**
 * Read-only YouTube intake qualification. It never downloads media, prints
 * credentials, or mutates source state. A failed check is an actionable
 * qualification result, not a reason to enqueue a production job.
 */
import { readFile, stat } from "fs/promises";
import { resolve } from "path";
import { config } from "../config/index.js";
import { classifyYouTubeFailure, youtubeVideoId } from "../media/downloader.js";
import { runManagedProcess } from "../runtime/managed-process.js";

type CheckStatus = "pass" | "fail" | "unknown";
interface Check { name: string; status: CheckStatus; detail: string }

const url = process.argv.find((value) => value.startsWith("--url="))?.slice(6)
  ?? process.argv[process.argv.indexOf("--url") + 1];
if (!url || !youtubeVideoId(url)) {
  console.error("usage: npm run youtube:qualify -- --url https://www.youtube.com/watch?v=<id>");
  process.exitCode = 2;
} else {
  void qualify(url);
}

function commandPath(name: string): string {
  const configured = name === "yt-dlp" ? process.env.YTDLP_BIN : undefined;
  if (name === "node") return process.execPath;
  return configured?.trim() || resolve(process.cwd(), ".youtube-runtime", "bin", name);
}

async function runVersion(command: string): Promise<{ status: CheckStatus; detail: string }> {
  try {
    const result = await runManagedProcess({ label: command, args: ["--version"], timeoutMs: 15_000 });
    if (result.code !== 0) return { status: "fail", detail: `${command} exited with ${result.code}` };
    return { status: "pass", detail: `${command} is runnable` };
  } catch (error) {
    return { status: "fail", detail: `${command} is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function qualify(target: string): Promise<void> {
  const videoId = youtubeVideoId(target)!;
  const checks: Check[] = [];
  const ytdlp = commandPath("yt-dlp");
  const node = commandPath("node");
  checks.push({ name: "yt_dlp", ...(await runVersion(ytdlp)) });
  checks.push({ name: "javascript_runtime", ...(await runVersion(node)) });
  checks.push(await qualifyEjsRuntime());
  checks.push(await qualifyCookies());
  checks.push(await qualifyPoTokenProvider());

  let metadata: Record<string, unknown> | undefined;
  try {
    let stdout = "";
    let stderr = "";
    let metadataOversized = false;
    const args = [
      "--js-runtimes", "node", "--dump-single-json", "--skip-download",
      "--no-playlist", "--no-warnings",
      ...(config.youtubeCookiesFile ? ["--cookies", config.youtubeCookiesFile] : []),
      ...providerArgs(), target,
    ];
    const result = await runManagedProcess({
      label: "yt-dlp", args, timeoutMs: 90_000,
      onStdout: (chunk) => {
        if (stdout.length + chunk.length > 16 * 1024 * 1024) metadataOversized = true;
        else stdout += chunk.toString();
      },
      onStderr: (chunk) => { stderr = (stderr + chunk.toString()).slice(-8_192); },
    });
    if (result.code !== 0) throw new Error(stderr || `yt-dlp exited with ${result.code}`);
    if (metadataOversized) throw new Error("yt-dlp metadata exceeded the bounded qualification contract");
    const raw = stdout.trim().split("\n").pop() ?? "";
    metadata = JSON.parse(raw) as Record<string, unknown>;
    checks.push({ name: "fresh_metadata", status: "pass", detail: "fresh metadata extraction succeeded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: "fresh_metadata", status: "fail", detail: `${classifyYouTubeFailure(message)}: ${message.slice(-500)}` });
  }

  const selected = selectMuxedFormat(metadata);
  checks.push(selected
    ? { name: "bounded_muxed_format", status: "pass", detail: `${selected.height}p ${selected.videoCodec} with ${selected.audioCodec}` }
    : { name: "bounded_muxed_format", status: "fail", detail: "no muxed non-AV1 format at or below 720p with usable audio" });

  const failed = checks.some((check) => check.status === "fail");
  const unknown = checks.some((check) => check.status === "unknown");
  process.stdout.write(JSON.stringify({
    schema_version: "youtube-qualification/v1",
    video_id: videoId,
    status: failed ? "failed" : unknown ? "unqualified" : "qualified",
    checks,
    selected_format: selected ? { height: selected.height, video_codec: selected.videoCodec, audio_codec: selected.audioCodec } : null,
  }, null, 2) + "\n");
  if (failed) process.exitCode = 1;
}

async function qualifyEjsRuntime(): Promise<Check> {
  const python = resolve(process.cwd(), ".youtube-runtime", "bin", "python");
  try {
    const result = await runManagedProcess({
      label: "python",
      args: ["-c", "import importlib.metadata as m; m.version('yt-dlp-ejs')"],
      timeoutMs: 15_000,
    });
    return result.code === 0
      ? { name: "yt_dlp_ejs", status: "pass", detail: "yt-dlp EJS challenge runtime is installed" }
      : { name: "yt_dlp_ejs", status: "fail", detail: "yt-dlp EJS challenge runtime is unavailable" };
  } catch {
    return { name: "yt_dlp_ejs", status: "fail", detail: "yt-dlp EJS challenge runtime is unavailable" };
  }
}

function providerArgs(): string[] {
  if (!config.youtubePoTokenProviderUrl) return [];
  return ["--extractor-args", "youtube:player-client=mweb", "--extractor-args", `youtubepot-bgutilhttp:base_url=${config.youtubePoTokenProviderUrl}`];
}

async function qualifyCookies(): Promise<Check> {
  if (!config.youtubeCookiesFile) return { name: "cookie_jar", status: "unknown", detail: "no cookie jar configured" };
  try {
    const info = await stat(config.youtubeCookiesFile);
    if (!info.isFile() || info.size === 0 || info.size > 10 * 1024 * 1024) return { name: "cookie_jar", status: "fail", detail: "configured cookie jar is empty, too large, or not a regular file" };
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) return { name: "cookie_jar", status: "fail", detail: "cookie jar permissions are broader than owner-only" };
    const header = (await readFile(config.youtubeCookiesFile, "utf8")).replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0]?.trim().toLowerCase();
    if (header !== "# netscape http cookie file" && header !== "# http cookie file") return { name: "cookie_jar", status: "fail", detail: "cookie jar is not Netscape format" };
    return { name: "cookie_jar", status: "pass", detail: "owner-only Netscape cookie jar is readable" };
  } catch { return { name: "cookie_jar", status: "fail", detail: "configured cookie jar is not readable" }; }
}

async function qualifyPoTokenProvider(): Promise<Check> {
  const endpoint = config.youtubePoTokenProviderUrl;
  if (!endpoint) return { name: "po_token_provider", status: "unknown", detail: "no PO-token provider configured" };
  try {
    const response = await fetch(new URL("/health", endpoint), { signal: AbortSignal.timeout(10_000) });
    return { name: "po_token_provider", status: response.ok ? "pass" : "fail", detail: response.ok ? "provider health endpoint is reachable" : `provider returned HTTP ${response.status}` };
  } catch { return { name: "po_token_provider", status: "fail", detail: "provider health endpoint is unreachable" }; }
}

interface SelectedFormat { height: number; videoCodec: string; audioCodec: string; size: number }
function selectMuxedFormat(metadata: Record<string, unknown> | undefined): SelectedFormat | undefined {
  const formats = metadata?.formats;
  if (!Array.isArray(formats)) return undefined;
  return formats.flatMap((raw): SelectedFormat[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const videoCodec = String(item.vcodec ?? "").toLowerCase();
    const audioCodec = String(item.acodec ?? "").toLowerCase();
    const height = Number(item.height ?? 0);
    const size = Number(item.filesize ?? item.filesize_approx ?? 0);
    if (!videoCodec || videoCodec === "none" || !audioCodec || audioCodec === "none" || !height || height > 720 || /av01|av1/.test(videoCodec)) return [];
    if (size > 0 && size > 2 * 1024 * 1024 * 1024) return [];
    return [{ height, videoCodec, audioCodec, size }];
  }).sort((a, b) => b.height - a.height || a.size - b.size)[0];
}
