/**
 * Media Downloader
 * Downloads media from YouTube (yt-dlp) and HTTP sources
 */
import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { mkdir, unlink, stat } from 'fs/promises';
import { join, basename } from 'path';
import { pipeline } from 'stream/promises';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';

export interface DownloadResult {
    filePath: string;
    format: string;
    duration?: number;
    title?: string;
    thumbnailUrl?: string;
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

    return new Promise((resolve, reject) => {
        // yt-dlp arguments for best quality video+audio merged to mp4
        const args = [
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--merge-output-format', 'mp4',
            '-o', outputTemplate,
            '--no-playlist',
            '--write-info-json',
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
                logger.error('yt-dlp failed', { code, stderr, url });
                reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
                return;
            }

            try {
                // Parse JSON output from yt-dlp
                const metadata = JSON.parse(stdout.trim().split('\n').pop() || '{}');

                // Find the actual downloaded file
                const actualPath = getTempPath(contentItemId, metadata.ext || 'mp4');

                await stat(actualPath); // Verify file exists

                logger.info('YouTube download complete', {
                    contentItemId,
                    title: metadata.title,
                    duration: metadata.duration,
                });

                resolve({
                    filePath: actualPath,
                    format: metadata.ext || 'mp4',
                    duration: metadata.duration,
                    title: metadata.title,
                    thumbnailUrl: metadata.thumbnail,
                });
            } catch (parseError) {
                // Fallback if JSON parsing fails
                logger.warn('Failed to parse yt-dlp output, using defaults', { parseError });
                resolve({
                    filePath: outputPath,
                    format: 'mp4',
                });
            }
        });

        proc.on('error', (error) => {
            logger.error('yt-dlp spawn error', error);
            reject(error);
        });
    });
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
    cleanupTempFile,
    getTempPath,
    ensureTempDir,
};
