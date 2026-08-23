/**
 * Media Downloader
 * Downloads media from YouTube (yt-dlp) and HTTP sources
 */
import { createWriteStream } from "fs";
import { mkdir, readFile, rename, unlink, stat, writeFile } from "fs/promises";
import { join, basename } from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { config } from "../config/index.js";
import { logger } from "../observability/logger.js";
import { assertPublicUrl, safeFetchResponse } from "../utils/safe-fetch.js";
import { runManagedProcess } from "../runtime/managed-process.js";
import {
  createTelegramClient,
  disconnectTelegramClient,
  wrapTelegramMediaDownloadError,
} from "../services/telegram-client.js";
import {
  extractCaptionsAndChapters,
  type ExtractedCaptions,
  type HeatmapPoint,
  type SponsorSegment,
} from "./captions.js";
import type { TranscriptChapter } from "../cms/types.js";

export interface DownloadResult {
  filePath: string;
  format: string;
  duration?: number;
  title?: string;
  thumbnailUrl?: string;
  // Caption-first (YouTube only): the best caption track + native chapters,
  // parsed from the same yt-dlp call's info-json + subtitle files.
  captions?: ExtractedCaptions;
  chapters?: TranscriptChapter[];
  // Extra YouTube signals from the same info-json (engagement + segments).
  heatmap?: HeatmapPoint[];
  sponsorSegments?: SponsorSegment[];
  categories?: string[];
}

// Flags appended to YouTube yt-dlp calls. Fetches human + auto captions for
// Arabic/English. Parsing happens in captions.ts; auto-translated caption tracks
// are rejected there.
const SUBTITLE_ARGS = [
  "--write-subs",
  "--write-auto-subs",
  "--sub-langs",
  "ar.*,en.*",
  "--sub-format",
  "vtt",
];

// Mark (don't cut) sponsor/intro/outro/… segments into the info-json. Kept
// separate so we can retry media download without subtitle files if YouTube
// rate-limits captions.
const SPONSORBLOCK_ARGS = ["--sponsorblock-mark", "all"];

// Safety cap for a single media download. Code default (not env) per config
// discipline. Podcast/video episodes are well under this; anything larger is
// almost certainly a mistake or abuse.
export const MAX_MEDIA_DOWNLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB
// The canonical ingest profile caps output at 720p. Downloading 1080p/4K only
// increases transfer, disk, and encode pressure before those pixels are thrown
// away by the transcoder.
export const YOUTUBE_VIDEO_FORMAT =
  "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720][ext=mp4]/best[height<=720]";
export const YOUTUBE_FORCE_OVERWRITE_ARGS = ["--force-overwrites"] as const;
const MAX_YTDLP_BUF = 4 * 1024 * 1024; // Tail keeps --print-json and recent logs.
const MEDIA_RESPONSE_TIMEOUT_MS = 30_000;

interface TelegramDownloadRef {
  channelUsername: string;
  channelId?: string;
  messageId: number;
  mediaKind: "audio" | "voice" | "video" | "photo";
  fileName?: string;
  mimeType?: string;
}

/**
 * Throws if a Content-Length header declares a size over the cap.
 */
export function assertContentLengthWithinCap(
  contentLengthHeader: string | null,
  cap: number = MAX_MEDIA_DOWNLOAD_BYTES,
): void {
  if (!contentLengthHeader) {
    return;
  }

  const declared = Number(contentLengthHeader);
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(
      `media download exceeds size cap: ${declared} > ${cap} bytes`,
    );
  }
}

/**
 * Append `chunk` to `buf` but keep only the last `maxBytes` characters.
 */
export function boundedAppend(
  buf: string,
  chunk: string,
  maxBytes: number,
): string {
  const next = buf + chunk;
  return next.length > maxBytes ? next.slice(next.length - maxBytes) : next;
}

/**
 * Ensure temp directory exists
 */
async function ensureTempDir(tempDir = config.mediaTempDir): Promise<string> {
  await mkdir(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Generate temp file path
 */
function getTempPath(
  contentItemId: string,
  extension: string,
  tempDir = config.mediaTempDir,
): string {
  return join(tempDir, `${contentItemId}.${extension}`);
}

/** Return a same-item source download from an earlier attempt, if one exists. */
export async function findExistingYouTubeDownload(
  contentItemId: string,
  tempDir: string = config.mediaTempDir,
): Promise<DownloadResult | undefined> {
  for (const format of ["mp4", "mkv", "webm", "m4a"]) {
    const filePath = join(tempDir, `${contentItemId}.${format}`);
    try {
      const file = await stat(filePath);
      if (file.isFile() && file.size > 0) return { filePath, format };
    } catch {
      // Try the next canonical yt-dlp output extension.
    }
  }
  return undefined;
}

export interface CachedYouTubeFallback {
  url: string;
  extension: string;
  height: number;
}

/**
 * Choose a muxed, bounded video+audio URL from yt-dlp metadata written by a
 * previous same-item attempt. The URL still passes downloadHttp's public-host,
 * response-type, and byte-cap checks before any file is accepted.
 */
export function selectCachedYouTubeFallback(
  metadata: unknown,
): CachedYouTubeFallback | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const formats = (metadata as { formats?: unknown }).formats;
  if (!Array.isArray(formats)) return undefined;

  const candidates = formats.flatMap((value): CachedYouTubeFallback[] => {
    if (!value || typeof value !== "object") return [];
    const format = value as Record<string, unknown>;
    const url = typeof format.url === "string" ? format.url : "";
    const extension =
      typeof format.ext === "string" ? format.ext.toLowerCase() : "";
    const height = Number(format.height ?? 0);
    const size = Number(format.filesize ?? format.filesize_approx ?? 0);
    const hasVideo =
      typeof format.vcodec === "string" && format.vcodec !== "none";
    const hasAudio =
      typeof format.acodec === "string" && format.acodec !== "none";
    let protocolAllowed = false;
    try {
      const protocol = new URL(url).protocol;
      protocolAllowed = protocol === "https:" || protocol === "http:";
    } catch {
      protocolAllowed = false;
    }
    if (
      !protocolAllowed ||
      !hasVideo ||
      !hasAudio ||
      !Number.isFinite(height) ||
      height <= 0 ||
      height > 720 ||
      (size > 0 && size > MAX_MEDIA_DOWNLOAD_BYTES) ||
      !["mp4", "webm"].includes(extension)
    ) {
      return [];
    }
    return [{ url, extension, height }];
  });

  return candidates.sort((a, b) => {
    if (a.height !== b.height) return b.height - a.height;
    return Number(b.extension === "mp4") - Number(a.extension === "mp4");
  })[0];
}

async function readCachedYouTubeFallback(
  contentItemId: string,
  tempDir = config.mediaTempDir,
): Promise<CachedYouTubeFallback | undefined> {
  try {
    const raw = await readFile(
      getTempPath(contentItemId, "info.json", tempDir),
      "utf8",
    );
    return selectCachedYouTubeFallback(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function isAllowedYouTubeUrl(rawUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(rawUrl);
    if (protocol !== "https:" && protocol !== "http:") return false;
    const host = hostname.toLowerCase();
    return (
      host === "youtu.be" ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com")
    );
  } catch {
    return false;
  }
}

async function assertAllowedYouTubeUrl(rawUrl: string): Promise<void> {
  if (!isAllowedYouTubeUrl(rawUrl)) {
    throw new Error("blocked non-YouTube media URL");
  }
  await assertPublicUrl(rawUrl);
}

interface YtDlpRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function runYtDlp(
  args: string[],
  url: string,
  options: YtDlpRunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? config.mediaJobTimeoutMs;
  let stdout = "";
  let stderr = "";
  const result = await runManagedProcess({
    label: "yt-dlp",
    args,
    timeoutMs,
    signal: options.signal,
    onStdout: (chunk) => {
      stdout = boundedAppend(stdout, chunk.toString(), MAX_YTDLP_BUF);
    },
    onStderr: (chunk) => {
      stderr = boundedAppend(stderr, chunk.toString(), MAX_YTDLP_BUF);
    },
  });
  if (result.code !== 0) {
    // URLs can contain signed credentials, so keep them out of the error
    // payload and logs while preserving bounded diagnostic output.
    logger.error("yt-dlp failed", { code: result.code, stderr });
    throw new Error(`yt-dlp exited with code ${result.code}: ${stderr}`);
  }
  return { stdout, stderr };
}

/**
 * Download YouTube video using yt-dlp
 */
export async function downloadYouTube(
  url: string,
  contentItemId: string,
  signal?: AbortSignal,
  tempDir = config.mediaTempDir,
): Promise<DownloadResult> {
  await ensureTempDir(tempDir);
  await assertAllowedYouTubeUrl(url);

  const outputTemplate = getTempPath(contentItemId, "%(ext)s", tempDir);
  const outputPath = getTempPath(contentItemId, "mp4", tempDir); // Expected output
  const existingDownload = await findExistingYouTubeDownload(
    contentItemId,
    tempDir,
  );
  const cachedFallback = await readCachedYouTubeFallback(
    contentItemId,
    tempDir,
  );
  const backupPath = existingDownload
    ? `${existingDownload.filePath}.retry-backup`
    : undefined;

  if (existingDownload && backupPath) {
    await unlink(backupPath).catch(() => {});
    await rename(existingDownload.filePath, backupPath);
  }

  const restoreExistingDownload = async (): Promise<
    DownloadResult | undefined
  > => {
    if (!existingDownload || !backupPath) return undefined;
    await unlink(existingDownload.filePath).catch(() => {});
    await rename(backupPath, existingDownload.filePath);
    return existingDownload;
  };

  const discardExistingBackup = async (): Promise<void> => {
    if (backupPath) await unlink(backupPath).catch(() => {});
  };

  logger.info("Starting YouTube download", { url, contentItemId });

  const buildArgs = (withSubtitles: boolean, forceOverwrite: boolean) => [
    "-f",
    YOUTUBE_VIDEO_FORMAT,
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    "--no-playlist",
    ...(forceOverwrite ? YOUTUBE_FORCE_OVERWRITE_ARGS : []),
    "--write-info-json",
    ...(withSubtitles ? SUBTITLE_ARGS : []),
    ...SPONSORBLOCK_ARGS,
    "--print-json",
    url,
  ];

  const parseResult = async (stdout: string): Promise<DownloadResult> => {
    try {
      // Parse JSON output from yt-dlp
      const metadata = JSON.parse(stdout.trim().split("\n").pop() || "{}");

      // Find the actual downloaded file
      const actualPath = getTempPath(
        contentItemId,
        metadata.ext || "mp4",
        tempDir,
      );

      await stat(actualPath); // Verify file exists

      // Caption-first: read chapters, the best caption track, plus
      // heatmap / SponsorBlock / categories from the info-json + .vtt
      // files yt-dlp just wrote (no extra request). Best-effort.
      const { captions, chapters, heatmap, sponsorSegments, categories } =
        await extractCaptionsAndChapters(
          getTempPath(contentItemId, "info.json", tempDir),
        );

      logger.info("YouTube download complete", {
        contentItemId,
        title: metadata.title,
        duration: metadata.duration,
        hasCaptions: !!captions,
        captionIsAuto: captions?.isAuto,
        chapterCount: chapters.length,
        heatmapPoints: heatmap?.length ?? 0,
        sponsorSegments: sponsorSegments?.length ?? 0,
      });

      return {
        filePath: actualPath,
        format: metadata.ext || "mp4",
        duration: metadata.duration,
        title: metadata.title,
        thumbnailUrl: metadata.thumbnail,
        captions,
        chapters,
        heatmap,
        sponsorSegments,
        categories,
      };
    } catch (parseError) {
      // Fallback if JSON parsing fails
      logger.warn("Failed to parse yt-dlp output, using defaults", {
        parseError,
      });
      return {
        filePath: outputPath,
        format: "mp4",
      };
    }
  };

  try {
    // Replace a prior source when YouTube is available so retries honor the
    // current 720p ingest ceiling. yt-dlp writes through a .part file, so a
    // pre-existing complete source remains available if extraction is
    // rejected before transfer begins.
    const { stdout } = await runYtDlp(buildArgs(true, true), url, { signal });
    const result = await parseResult(stdout);
    await discardExistingBackup();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to download video subtitles")) {
      logger.warn(
        "YouTube subtitle download failed; retrying media without subtitles",
        {
          url,
          contentItemId,
          error: message,
        },
      );
      try {
        const { stdout } = await runYtDlp(buildArgs(false, false), url, {
          signal,
        });
        const result = await parseResult(stdout);
        await discardExistingBackup();
        return result;
      } catch (subtitleRetryError) {
        await restoreExistingDownload();
        throw subtitleRetryError;
      }
    }

    const restoredDownload = await restoreExistingDownload();
    if (message.includes("Sign in to confirm you")) {
      if (restoredDownload) {
        logger.warn(
          "YouTube challenged fresh download; reusing validated same-item source",
          {
            contentItemId,
            format: restoredDownload.format,
          },
        );
        return restoredDownload;
      }
      if (cachedFallback) {
        logger.warn(
          "YouTube challenged extraction; downloading bounded same-item cached format",
          {
            contentItemId,
            format: cachedFallback.extension,
            height: cachedFallback.height,
          },
        );
        return downloadHttp(
          cachedFallback.url,
          contentItemId,
          cachedFallback.extension,
          signal,
          tempDir,
        );
      }
    }
    throw err;
  }
}

/**
 * Download audio from YouTube using yt-dlp (for podcast/audio-only)
 */
export async function downloadYouTubeAudio(
  url: string,
  contentItemId: string,
  signal?: AbortSignal,
  tempDir = config.mediaTempDir,
): Promise<DownloadResult> {
  await ensureTempDir(tempDir);
  await assertAllowedYouTubeUrl(url);

  const outputPath = getTempPath(contentItemId, "m4a", tempDir);

  logger.info("Starting YouTube audio download", { url, contentItemId });

  const args = [
    "-f",
    "bestaudio[ext=m4a]/bestaudio",
    "-x",
    "--audio-format",
    "m4a",
    "-o",
    outputPath,
    "--no-playlist",
    "--print-json",
    url,
  ];

  const { stdout } = await runYtDlp(args, url, { signal });
  try {
    const metadata = JSON.parse(stdout.trim().split("\n").pop() || "{}");

    return {
      filePath: outputPath,
      format: "m4a",
      duration: metadata.duration,
      title: metadata.title,
      thumbnailUrl: metadata.thumbnail,
    };
  } catch {
    return {
      filePath: outputPath,
      format: "m4a",
    };
  }
}

/**
 * Download file via HTTP (for podcast enclosures)
 */
export async function downloadHttp(
  url: string,
  contentItemId: string,
  expectedExtension?: string,
  signal?: AbortSignal,
  tempDir = config.mediaTempDir,
): Promise<DownloadResult> {
  if (signal?.aborted) throw signal.reason;
  await ensureTempDir(tempDir);

  // Determine extension from URL or use default
  const urlPath = new URL(url).pathname;
  const ext = expectedExtension || basename(urlPath).split(".").pop() || "mp3";
  await mkdir(tempDir, { recursive: true });
  const outputPath = join(tempDir, `${contentItemId}.${ext}`);

  logger.debug("Starting HTTP download", { url, contentItemId, ext });

  const { response, close } = await safeFetchResponse(url, {
    timeoutMs: MEDIA_RESPONSE_TIMEOUT_MS,
    signal,
    rateLimit: false,
    headers: {
      "User-Agent": "WahbBot/1.0 (Media Download)",
      Accept: "audio/*,video/*,application/octet-stream,*/*;q=0.5",
    },
  });

  try {
    if (!response.ok) {
      throw new Error(
        `HTTP download failed: ${response.status} ${response.statusText}`,
      );
    }

    // Defense-in-depth: reject clearly-textual responses before saving. A 200 HTML
    // page (e.g. an article/tweet URL mistakenly enqueued as media) would otherwise
    // be written as .mp4 and fail ffprobe later with a cryptic "moov atom not found".
    // Stay permissive — allow audio/video, octet-stream, and missing/unknown types
    // (some CDNs mislabel mp3s); only reject obviously non-media content types.
    const contentType = (
      response.headers.get("content-type") || ""
    ).toLowerCase();
    if (
      contentType.startsWith("text/") ||
      contentType.includes("html") ||
      contentType.includes("json") ||
      contentType.includes("xml")
    ) {
      throw new Error(
        `HTTP download returned non-media content-type: ${contentType}`,
      );
    }

    assertContentLengthWithinCap(response.headers.get("content-length"));

    const fileStream = createWriteStream(outputPath);
    let bytesWritten = 0;
    const capCounter = new Transform({
      transform(chunk, _encoding, callback) {
        bytesWritten += chunk.length;
        if (bytesWritten > MAX_MEDIA_DOWNLOAD_BYTES) {
          callback(
            new Error(
              `media download exceeds size cap during stream: > ${MAX_MEDIA_DOWNLOAD_BYTES} bytes`,
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      // @ts-expect-error - Undici fetch body is a Web ReadableStream.
      await pipeline(response.body, capCounter, fileStream, { signal });
    } catch (error) {
      await cleanupTempFile(outputPath).catch(() => {});
      throw error;
    }

    if (signal?.aborted) throw signal.reason;
    const fileStats = await stat(outputPath);

    logger.info("HTTP download complete", {
      contentItemId,
      size: fileStats.size,
      ext,
    });

    return {
      filePath: outputPath,
      format: ext,
    };
  } finally {
    await close();
  }
}

/**
 * Download Telegram media by channel + message locator
 */
export async function downloadTelegram(
  downloadRef: TelegramDownloadRef,
  contentItemId: string,
  signal?: AbortSignal,
  tempDir = config.mediaTempDir,
): Promise<DownloadResult> {
  if (signal?.aborted) throw signal.reason;
  await ensureTempDir(tempDir);

  if (
    !config.telegramApiId ||
    !config.telegramApiHash ||
    !config.telegramSessionString
  ) {
    throw new Error(
      "Telegram is not configured. TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_SESSION_STRING are required",
    );
  }

  const extension = inferTelegramExtension(downloadRef);
  const outputPath = getTempPath(contentItemId, extension, tempDir);
  const normalizedChannel = normalizeTelegramChannel(
    downloadRef.channelUsername,
  );
  if (!normalizedChannel) {
    throw new Error("Telegram downloadRef.channelUsername is required");
  }
  if (!Number.isInteger(downloadRef.messageId) || downloadRef.messageId <= 0) {
    throw new Error(
      "Telegram downloadRef.messageId must be a positive integer",
    );
  }

  logger.info("Starting Telegram media download", {
    contentItemId,
    channel: normalizedChannel,
    messageId: downloadRef.messageId,
    mediaKind: downloadRef.mediaKind,
  });

  const client = createTelegramClient();
  const abortTelegram = () => {
    void client.disconnect().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortTelegram, { once: true });

  try {
    await client.connect();
    const messages = await client.getMessages(normalizedChannel, {
      ids: [downloadRef.messageId],
    });
    const message = messages?.[0];

    if (!message) {
      throw new Error(
        `Telegram message ${downloadRef.messageId} not found in ${normalizedChannel}`,
      );
    }

    const mediaData = await client.downloadMedia(message);
    if (!mediaData) {
      throw new Error("Telegram media download returned empty payload");
    }

    if (typeof mediaData === "string") {
      // Some clients may return a local path when file mode is used.
      // Verify and reuse that path as the downloaded artifact.
      const mediaStats = await stat(mediaData);
      if (mediaStats.size > MAX_MEDIA_DOWNLOAD_BYTES) {
        throw new Error(
          `Telegram media exceeds size cap: ${mediaStats.size} > ${MAX_MEDIA_DOWNLOAD_BYTES} bytes`,
        );
      }
      return {
        filePath: mediaData,
        format: extension,
      };
    }

    const buffer =
      mediaData instanceof Uint8Array
        ? Buffer.from(mediaData)
        : Buffer.from([]);

    if (buffer.length === 0) {
      throw new Error("Telegram media download returned unsupported data type");
    }
    if (buffer.length > MAX_MEDIA_DOWNLOAD_BYTES) {
      throw new Error(
        `Telegram media exceeds size cap: ${buffer.length} > ${MAX_MEDIA_DOWNLOAD_BYTES} bytes`,
      );
    }

    await writeFile(outputPath, buffer);
    await stat(outputPath);

    logger.info("Telegram media download complete", {
      contentItemId,
      outputPath,
      size: buffer.length,
    });

    return {
      filePath: outputPath,
      format: extension,
    };
  } catch (error) {
    throw wrapTelegramMediaDownloadError(error);
  } finally {
    signal?.removeEventListener("abort", abortTelegram);
    await disconnectTelegramClient(client, {
      contentItemId,
      channel: normalizedChannel,
      messageId: downloadRef.messageId,
    });
  }
}

function normalizeTelegramChannel(channelUsername: string): string {
  const trimmed = channelUsername.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("@")) {
    return trimmed;
  }
  if (
    trimmed.startsWith("https://t.me/") ||
    trimmed.startsWith("http://t.me/")
  ) {
    const withoutPrefix = trimmed.replace(/^https?:\/\/t\.me\//, "");
    const cleaned = withoutPrefix.replace(/^s\//, "");
    const username = cleaned.split("/")[0];
    return username ? `@${username}` : "";
  }
  if (
    trimmed.startsWith("https://telegram.me/") ||
    trimmed.startsWith("http://telegram.me/")
  ) {
    const withoutPrefix = trimmed.replace(/^https?:\/\/telegram\.me\//, "");
    const username = withoutPrefix.split("/")[0];
    return username ? `@${username}` : "";
  }
  return `@${trimmed}`;
}

function inferTelegramExtension(downloadRef: TelegramDownloadRef): string {
  const fileName = downloadRef.fileName?.toLowerCase() || "";
  if (fileName.endsWith(".m4a")) return "m4a";
  if (fileName.endsWith(".mp3")) return "mp3";
  if (fileName.endsWith(".ogg")) return "ogg";
  if (fileName.endsWith(".wav")) return "wav";
  if (fileName.endsWith(".opus")) return "opus";
  if (fileName.endsWith(".mp4")) return "mp4";
  if (fileName.endsWith(".mov")) return "mov";
  if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) return "jpg";
  if (fileName.endsWith(".png")) return "png";
  if (fileName.endsWith(".webp")) return "webp";

  const mimeType = downloadRef.mimeType?.toLowerCase() || "";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("video")) return "mp4";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";

  if (downloadRef.mediaKind === "photo") return "jpg";
  if (downloadRef.mediaKind === "video") return "mp4";
  return downloadRef.mediaKind === "voice" ? "ogg" : "mp3";
}

export const downloaderTestUtils = {
  normalizeTelegramChannel,
  inferTelegramExtension,
};

/**
 * Clean up temp file
 */
export async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
    logger.debug("Cleaned up temp file", { filePath });
  } catch (error) {
    logger.warn("Failed to cleanup temp file", { filePath, error });
  }
}

export const downloader = {
  downloadYouTube,
  downloadYouTubeAudio,
  downloadHttp,
  downloadTelegram,
  cleanupTempFile,
  getTempPath,
  ensureTempDir,
};
