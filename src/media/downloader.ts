/**
 * Media Downloader
 * Downloads media from YouTube (yt-dlp) and HTTP sources
 */
import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { mkdir, unlink, stat, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { pipeline } from 'stream/promises';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import {
    extractCaptionsAndChapters,
    type ExtractedCaptions,
    type HeatmapPoint,
    type SponsorSegment,
} from './captions.js';
import type { TranscriptChapter } from '../cms/types.js';

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
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', 'ar.*,en.*',
    '--sub-format', 'vtt',
];

// Mark (don't cut) sponsor/intro/outro/… segments into the info-json. Kept
// separate so we can retry media download without subtitle files if YouTube
// rate-limits captions.
const SPONSORBLOCK_ARGS = [
    '--sponsorblock-mark', 'all',
];

interface TelegramDownloadRef {
    channelUsername: string;
    channelId?: string;
    messageId: number;
    mediaKind: 'audio' | 'voice' | 'video' | 'photo';
    fileName?: string;
    mimeType?: string;
}

/**
 * Ensure temp directory exists
 */
async function ensureTempDir(): Promise<string> {
    const tempDir = config.mediaTempDir;
    await mkdir(tempDir, { recursive: true });
    return tempDir;
}

/**
 * Generate temp file path
 */
function getTempPath(contentItemId: string, extension: string): string {
    return join(config.mediaTempDir, `${contentItemId}.${extension}`);
}

/**
 * Download YouTube video using yt-dlp
 */
export async function downloadYouTube(
    url: string,
    contentItemId: string
): Promise<DownloadResult> {
    await ensureTempDir();

    const outputTemplate = getTempPath(contentItemId, '%(ext)s');
    const outputPath = getTempPath(contentItemId, 'mp4'); // Expected output

    logger.info('Starting YouTube download', { url, contentItemId });

    const buildArgs = (withSubtitles: boolean) => [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', outputTemplate,
        '--no-playlist',
        '--write-info-json',
        ...(withSubtitles ? SUBTITLE_ARGS : []),
        ...SPONSORBLOCK_ARGS,
        '--print-json',
        url,
    ];

    const runYtDlp = (args: string[]) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        // yt-dlp arguments for best quality video+audio merged to mp4
        const proc = spawn('yt-dlp', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', async (code) => {
            if (code !== 0) {
                logger.error('yt-dlp failed', { code, stderr, url });
                reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
                return;
            }
            resolve({ stdout, stderr });
        });

        proc.on('error', (error) => {
            logger.error('yt-dlp spawn error', error);
            reject(error);
        });
    });

    const parseResult = async (stdout: string): Promise<DownloadResult> => {
        try {
            // Parse JSON output from yt-dlp
            const metadata = JSON.parse(stdout.trim().split('\n').pop() || '{}');

            // Find the actual downloaded file
            const actualPath = getTempPath(contentItemId, metadata.ext || 'mp4');

            await stat(actualPath); // Verify file exists

            // Caption-first: read chapters, the best caption track, plus
            // heatmap / SponsorBlock / categories from the info-json + .vtt
            // files yt-dlp just wrote (no extra request). Best-effort.
            const { captions, chapters, heatmap, sponsorSegments, categories } =
                await extractCaptionsAndChapters(getTempPath(contentItemId, 'info.json'));

            logger.info('YouTube download complete', {
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
                format: metadata.ext || 'mp4',
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
            logger.warn('Failed to parse yt-dlp output, using defaults', { parseError });
            return {
                filePath: outputPath,
                format: 'mp4',
            };
        }
    };

    try {
        const { stdout } = await runYtDlp(buildArgs(true));
        return parseResult(stdout);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('Unable to download video subtitles')) {
            throw err;
        }
        logger.warn('YouTube subtitle download failed; retrying media without subtitles', {
            url,
            contentItemId,
            error: message,
        });
        const { stdout } = await runYtDlp(buildArgs(false));
        return parseResult(stdout);
    }
}

/**
 * Download audio from YouTube using yt-dlp (for podcast/audio-only)
 */
export async function downloadYouTubeAudio(
    url: string,
    contentItemId: string
): Promise<DownloadResult> {
    await ensureTempDir();

    const outputPath = getTempPath(contentItemId, 'm4a');

    logger.info('Starting YouTube audio download', { url, contentItemId });

    return new Promise((resolve, reject) => {
        const args = [
            '-f', 'bestaudio[ext=m4a]/bestaudio',
            '-x', '--audio-format', 'm4a',
            '-o', outputPath,
            '--no-playlist',
            '--print-json',
            url,
        ];

        const proc = spawn('yt-dlp', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', async (code) => {
            if (code !== 0) {
                reject(new Error(`yt-dlp audio exited with code ${code}: ${stderr}`));
                return;
            }

            try {
                const metadata = JSON.parse(stdout.trim().split('\n').pop() || '{}');

                resolve({
                    filePath: outputPath,
                    format: 'm4a',
                    duration: metadata.duration,
                    title: metadata.title,
                    thumbnailUrl: metadata.thumbnail,
                });
            } catch {
                resolve({
                    filePath: outputPath,
                    format: 'm4a',
                });
            }
        });

        proc.on('error', reject);
    });
}

/**
 * Download file via HTTP (for podcast enclosures)
 */
export async function downloadHttp(
    url: string,
    contentItemId: string,
    expectedExtension?: string
): Promise<DownloadResult> {
    await ensureTempDir();

    // Determine extension from URL or use default
    const urlPath = new URL(url).pathname;
    const ext = expectedExtension || basename(urlPath).split('.').pop() || 'mp3';
    const outputPath = getTempPath(contentItemId, ext);

    logger.info('Starting HTTP download', { url, contentItemId, ext });

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'WahbBot/1.0 (Media Download)',
        },
    });

    if (!response.ok) {
        throw new Error(`HTTP download failed: ${response.status} ${response.statusText}`);
    }

    const fileStream = createWriteStream(outputPath);

    // @ts-expect-error - Node.js fetch body is a ReadableStream
    await pipeline(response.body, fileStream);

    const fileStats = await stat(outputPath);

    logger.info('HTTP download complete', {
        contentItemId,
        size: fileStats.size,
        ext,
    });

    return {
        filePath: outputPath,
        format: ext,
    };
}

/**
 * Download Telegram media by channel + message locator
 */
export async function downloadTelegram(
    downloadRef: TelegramDownloadRef,
    contentItemId: string
): Promise<DownloadResult> {
    await ensureTempDir();

    if (!config.telegramApiId || !config.telegramApiHash || !config.telegramSessionString) {
        throw new Error('Telegram is not configured. TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_SESSION_STRING are required');
    }

    const extension = inferTelegramExtension(downloadRef);
    const outputPath = getTempPath(contentItemId, extension);
    const normalizedChannel = normalizeTelegramChannel(downloadRef.channelUsername);
    if (!normalizedChannel) {
        throw new Error('Telegram downloadRef.channelUsername is required');
    }
    if (!Number.isInteger(downloadRef.messageId) || downloadRef.messageId <= 0) {
        throw new Error('Telegram downloadRef.messageId must be a positive integer');
    }

    logger.info('Starting Telegram media download', {
        contentItemId,
        channel: normalizedChannel,
        messageId: downloadRef.messageId,
        mediaKind: downloadRef.mediaKind,
    });

    const client = new TelegramClient(
        new StringSession(config.telegramSessionString),
        config.telegramApiId,
        config.telegramApiHash,
        { connectionRetries: 3 }
    );

    try {
        await client.connect();
        const messages = await client.getMessages(normalizedChannel, { ids: [downloadRef.messageId] });
        const message = messages?.[0];

        if (!message) {
            throw new Error(`Telegram message ${downloadRef.messageId} not found in ${normalizedChannel}`);
        }

        const mediaData = await client.downloadMedia(message);
        if (!mediaData) {
            throw new Error('Telegram media download returned empty payload');
        }

        if (typeof mediaData === 'string') {
            // Some clients may return a local path when file mode is used.
            // Verify and reuse that path as the downloaded artifact.
            await stat(mediaData);
            return {
                filePath: mediaData,
                format: extension,
            };
        }

        const buffer = mediaData instanceof Uint8Array
            ? Buffer.from(mediaData)
            : Buffer.from([]);

        if (buffer.length === 0) {
            throw new Error('Telegram media download returned unsupported data type');
        }

        await writeFile(outputPath, buffer);
        await stat(outputPath);

        logger.info('Telegram media download complete', {
            contentItemId,
            outputPath,
            size: buffer.length,
        });

        return {
            filePath: outputPath,
            format: extension,
        };
    } finally {
        await client.disconnect();
    }
}

function normalizeTelegramChannel(channelUsername: string): string {
    const trimmed = channelUsername.trim();
    if (!trimmed) {
        return '';
    }
    if (trimmed.startsWith('@')) {
        return trimmed;
    }
    if (trimmed.startsWith('https://t.me/') || trimmed.startsWith('http://t.me/')) {
        const withoutPrefix = trimmed.replace(/^https?:\/\/t\.me\//, '');
        const cleaned = withoutPrefix.replace(/^s\//, '');
        const username = cleaned.split('/')[0];
        return username ? `@${username}` : '';
    }
    if (trimmed.startsWith('https://telegram.me/') || trimmed.startsWith('http://telegram.me/')) {
        const withoutPrefix = trimmed.replace(/^https?:\/\/telegram\.me\//, '');
        const username = withoutPrefix.split('/')[0];
        return username ? `@${username}` : '';
    }
    return `@${trimmed}`;
}

function inferTelegramExtension(downloadRef: TelegramDownloadRef): string {
    const fileName = downloadRef.fileName?.toLowerCase() || '';
    if (fileName.endsWith('.m4a')) return 'm4a';
    if (fileName.endsWith('.mp3')) return 'mp3';
    if (fileName.endsWith('.ogg')) return 'ogg';
    if (fileName.endsWith('.wav')) return 'wav';
    if (fileName.endsWith('.opus')) return 'opus';
    if (fileName.endsWith('.mp4')) return 'mp4';
    if (fileName.endsWith('.mov')) return 'mov';
    if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) return 'jpg';
    if (fileName.endsWith('.png')) return 'png';
    if (fileName.endsWith('.webp')) return 'webp';

    const mimeType = downloadRef.mimeType?.toLowerCase() || '';
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
    if (mimeType.includes('png')) return 'png';
    if (mimeType.includes('webp')) return 'webp';
    if (mimeType.includes('video')) return 'mp4';
    if (mimeType.includes('mp4')) return 'm4a';
    if (mimeType.includes('mpeg')) return 'mp3';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('wav')) return 'wav';

    if (downloadRef.mediaKind === 'photo') return 'jpg';
    if (downloadRef.mediaKind === 'video') return 'mp4';
    return downloadRef.mediaKind === 'voice' ? 'ogg' : 'mp3';
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
        logger.debug('Cleaned up temp file', { filePath });
    } catch (error) {
        logger.warn('Failed to cleanup temp file', { filePath, error });
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
