import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config/index.js";
import { getObjectStream, type StorageTier } from "../storage/client.js";
import { MAX_MEDIA_DOWNLOAD_BYTES, type DownloadResult } from "./downloader.js";

// Only CMS-verified manifest keys belong here. External URLs continue through
// the public-host downloader; storage endpoints come from the S3 binding.
export async function downloadStorageObject(
  key: string,
  tier: StorageTier,
  contentItemId: string,
  extension: string,
  signal?: AbortSignal,
  tempDir = config.mediaTempDir,
): Promise<DownloadResult> {
  signal?.throwIfAborted();
  if (!/^[a-zA-Z0-9_-]+$/.test(contentItemId) || !/^[a-zA-Z0-9]+$/.test(extension)) {
    throw new Error("Invalid storage download filename");
  }
  await mkdir(tempDir, { recursive: true });
  const filePath = join(tempDir, `${contentItemId}.${extension}`);
  const stalled = new AbortController();
  const downloadSignal = signal ? AbortSignal.any([signal, stalled.signal]) : stalled.signal;
  const onStall = () => stalled.abort(new Error("Storage download made no progress for 30 seconds"));
  let timer = setTimeout(onStall, 30_000);
  timer.unref();
  let body: Readable | undefined;
  try {
    const object = await getObjectStream(key, tier, downloadSignal);
    body = object.body as Readable;
    if (object.size > MAX_MEDIA_DOWNLOAD_BYTES) throw new Error("Storage media exceeds size cap");
    const type = object.contentType?.toLowerCase() ?? "";
    if (type.startsWith("text/") || /html|json|xml/.test(type)) {
      throw new Error(`Storage object has non-media content-type: ${type}`);
    }
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        clearTimeout(timer);
        timer = setTimeout(onStall, 30_000);
        timer.unref();
        bytes += chunk.length;
        callback(bytes > MAX_MEDIA_DOWNLOAD_BYTES ? new Error("Storage media exceeds size cap during stream") : null, chunk);
      },
    });
    await pipeline(body, counter, createWriteStream(filePath), { signal: downloadSignal });
    downloadSignal.throwIfAborted();
    if (bytes === 0 || (object.size > 0 && bytes !== object.size)) {
      throw new Error("Storage media download is empty or incomplete");
    }
    return { filePath, format: extension };
  } catch (error) {
    body?.destroy();
    await rm(filePath, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
