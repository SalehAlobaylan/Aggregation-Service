/**
 * Media Transcoder
 * FFmpeg-based video/audio transcoding and thumbnail extraction
 */
import ffmpeg from 'fluent-ffmpeg';
import { deflateSync } from 'zlib';
import { join } from 'path';
import { stat, writeFile } from 'fs/promises';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';

export interface MediaInfo {
    duration: number;
    width?: number;
    height?: number;
    format: string;
    hasVideo: boolean;
    hasAudio: boolean;
}

export interface TranscodeResult {
    outputPath: string;
    duration: number;
}

/**
 * Get media file information using ffprobe
 */
export function getMediaInfo(inputPath: string): Promise<MediaInfo> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) {
                reject(err);
                return;
            }

            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

            resolve({
                duration: metadata.format.duration || 0,
                width: videoStream?.width,
                height: videoStream?.height,
                format: metadata.format.format_name || 'unknown',
                hasVideo: !!videoStream,
                hasAudio: !!audioStream,
            });
        });
    });
}

/**
 * Transcode video to MP4 (H.264/AAC baseline for mobile compatibility)
 */
export function transcodeToMp4(
    inputPath: string,
    outputPath: string
): Promise<TranscodeResult> {
    return new Promise((resolve, reject) => {
        logger.info('Starting MP4 transcode', { inputPath, outputPath });

        let duration = 0;

        ffmpeg(inputPath)
            .outputOptions([
                '-c:v libx264',           // H.264 video codec
                '-preset fast',           // Balance speed/quality
                '-profile:v baseline',    // Mobile compatibility
                '-level 3.0',
                '-crf 23',                // Quality (lower = better)
                '-c:a aac',               // AAC audio codec
                '-b:a 128k',              // Audio bitrate
                '-movflags +faststart',   // Enable streaming
                '-pix_fmt yuv420p',       // Pixel format compatibility
            ])
            .output(outputPath)
            .on('start', (cmd) => {
                logger.debug('FFmpeg command', { cmd });
            })
            .on('progress', (progress) => {
                if (progress.timemark) {
                    logger.debug('Transcode progress', { timemark: progress.timemark });
                }
            })
            .on('end', async () => {
                try {
                    const info = await getMediaInfo(outputPath);
                    duration = info.duration;

                    logger.info('MP4 transcode complete', {
                        inputPath,
                        outputPath,
                        duration,
                    });

                    resolve({ outputPath, duration });
                } catch (error) {
                    // Still resolve even if we can't get duration
                    resolve({ outputPath, duration: 0 });
                }
            })
            .on('error', (err) => {
                logger.error('FFmpeg transcode error', err);
                reject(err);
            })
            .run();
    });
}

/**
 * Convert audio to MP4 with a static visual (for For You feed requirement)
 * Creates an MP4 container with audio + placeholder image
 */
export function audioToMp4(
    inputPath: string,
    outputPath: string,
    coverImagePath?: string
): Promise<TranscodeResult> {
    return new Promise(async (resolve, reject) => {
        logger.info('Starting audio-to-MP4 conversion', { inputPath, outputPath });

        // Use provided cover or create a placeholder
        let imagePath = coverImagePath;

        if (!imagePath) {
            // Create a simple black placeholder image
            imagePath = join(config.mediaTempDir, 'placeholder.png');
            try {
                await stat(imagePath);
            } catch {
                // Generate placeholder using FFmpeg
                await generatePlaceholderImage(imagePath);
            }
        }

        ffmpeg()
            .input(imagePath)
            .inputOptions(['-loop 1'])  // Loop still image
            .input(inputPath)
            .outputOptions([
                '-c:v libx264',
                '-preset fast',
                '-profile:v baseline',
                '-level 3.0',
                '-tune stillimage',       // Optimize for still image
                '-c:a aac',
                '-b:a 128k',
                '-pix_fmt yuv420p',
                '-shortest',              // End when audio ends
                '-movflags +faststart',
            ])
            .output(outputPath)
            .on('end', async () => {
                try {
                    const info = await getMediaInfo(outputPath);

                    logger.info('Audio-to-MP4 conversion complete', {
                        outputPath,
                        duration: info.duration,
                    });

                    resolve({ outputPath, duration: info.duration });
                } catch {
                    resolve({ outputPath, duration: 0 });
                }
            })
            .on('error', (err) => {
                logger.error('Audio-to-MP4 error', err);
                reject(err);
            })
            .run();
    });
}

/**
 * Build a PNG chunk (length + type + data + CRC32)
 */
let _crcTable: Uint32Array | null = null;
function crc32(buf: Buffer): number {
    if (!_crcTable) {
        _crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            _crcTable[i] = c;
        }
    }
    let crc = 0xFFFFFFFF;
    for (const b of buf) crc = (_crcTable[(crc ^ b) & 0xFF]!) ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBytes = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([len, typeBytes, data, crcBuf]);
}

/**
 * Generate a 1280×720 solid-black PNG without using ffmpeg or lavfi.
 * Uses only Node's built-in zlib — works regardless of ffmpeg build flags.
 */
async function generatePlaceholderImage(outputPath: string): Promise<void> {
    const W = 1280, H = 720;
    // Each row: 1 filter byte (0 = None) + W*3 RGB bytes (all 0 = black)
    const row = Buffer.alloc(1 + W * 3, 0);
    const raw = Buffer.concat(Array.from({ length: H }, () => row));
    const compressed = deflateSync(raw);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB color type

    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG signature
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', compressed),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);

    await writeFile(outputPath, png);
    logger.debug('Generated placeholder image (pure Node.js)', { outputPath, size: png.length });
}

/**
 * Extract thumbnail from video at specified offset.
 * Writes to the exact outputPath provided (safe for concurrent jobs).
 */
export function extractThumbnail(
    inputPath: string,
    outputPath: string,
    offsetSeconds: number = 2
): Promise<string> {
    return new Promise((resolve, reject) => {
        logger.info('Extracting thumbnail', { inputPath, outputPath, offsetSeconds });

        ffmpeg(inputPath)
            .seekInput(offsetSeconds)
            .outputOptions(['-vframes 1', '-vf scale=640:360'])
            .output(outputPath)
            .on('end', () => {
                logger.info('Thumbnail extracted', { outputPath });
                resolve(outputPath);
            })
            .on('error', (err) => {
                logger.error('Thumbnail extraction error', err);
                reject(err);
            })
            .run();
    });
}

/**
 * Extract audio from video file
 */
export function extractAudio(
    inputPath: string,
    outputPath: string
): Promise<string> {
    return new Promise((resolve, reject) => {
        logger.info('Extracting audio', { inputPath, outputPath });

        ffmpeg(inputPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate(128)
            .output(outputPath)
            .on('end', () => {
                logger.info('Audio extracted', { outputPath });
                resolve(outputPath);
            })
            .on('error', (err) => {
                logger.error('Audio extraction error', err);
                reject(err);
            })
            .run();
    });
}

export const transcoder = {
    getMediaInfo,
    transcodeToMp4,
    audioToMp4,
    extractThumbnail,
    extractAudio,
};
