/**
 * Media Transcoder
 * FFmpeg-based video/audio transcoding and thumbnail extraction
 */
import ffmpeg from 'fluent-ffmpeg';
import { join } from 'path';
import { stat, readFile, writeFile } from 'fs/promises';
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
 * Generate a simple placeholder image for audio-to-MP4 conversion
 */
async function generatePlaceholderImage(outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input('color=c=black:s=1280x720:d=1')
            .inputFormat('lavfi')
            .outputOptions(['-frames:v 1'])
            .output(outputPath)
            .on('end', () => {
                logger.debug('Generated placeholder image', { outputPath });
                resolve();
            })
            .on('error', reject)
            .run();
    });
}

/**
 * Extract thumbnail from video at specified offset
 */
export function extractThumbnail(
    inputPath: string,
    outputPath: string,
    offsetSeconds: number = 2
): Promise<string> {
    return new Promise((resolve, reject) => {
        logger.info('Extracting thumbnail', { inputPath, outputPath, offsetSeconds });

        ffmpeg(inputPath)
            .screenshots({
                timestamps: [offsetSeconds],
                filename: 'thumb.jpg',
                folder: config.mediaTempDir,
                size: '640x360',
            })
            .on('end', () => {
                const thumbPath = join(config.mediaTempDir, 'thumb.jpg');
                logger.info('Thumbnail extracted', { thumbPath });
                resolve(thumbPath);
            })
            .on('error', (err) => {
                logger.error('Thumbnail extraction error', err);
                reject(err);
            });
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
