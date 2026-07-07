/**
 * Media Transcoder
 * FFmpeg-based video/audio transcoding and thumbnail extraction
 */
import ffmpeg from 'fluent-ffmpeg';
import { deflateSync } from 'zlib';
import { join } from 'path';
import { mkdir, stat, writeFile } from 'fs/promises';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';

export interface MediaInfo {
    duration: number;
    width?: number;
    height?: number;
    format: string;
    hasVideo: boolean;
    hasAudio: boolean;
    bitrateKbps?: number;
    videoCodec?: string;
    audioCodec?: string;
}

export interface TranscodeResult {
    outputPath: string;
    duration: number;
}

/**
 * EncodeProfile drives `transcodeToMp4`. The Quality Management System lets
 * admins create named profiles in CMS; the worker resolves them and passes
 * the parameters here. When `undefined` is supplied, DEFAULT_ENCODE_PROFILE
 * is used (matches the historical hard-coded recipe).
 */
export interface EncodeProfile {
    videoCodec: 'h264' | 'h265' | 'av1';
    /** 0 = no resolution cap. Always downscale-only — never upscale a small input. */
    maxHeight: number;
    /** kbps target. 0 = use CRF mode instead. */
    targetBitrateKbps: number;
    crf: number;
    preset: string;
    audioCodec: 'aac' | 'opus';
    audioBitrateKbps: number;
}

export const DEFAULT_ENCODE_PROFILE: EncodeProfile = {
    videoCodec: 'h264',
    maxHeight: 0,
    targetBitrateKbps: 0,
    crf: 23,
    preset: 'fast',
    audioCodec: 'aac',
    audioBitrateKbps: 128,
};

function runFfmpegWithTimeout(
    command: ReturnType<typeof ffmpeg>,
    label: string,
    reject: (reason?: unknown) => void,
    timeoutMs = config.mediaJobTimeoutMs
): void {
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        logger.warn('FFmpeg command timed out; killing child process', { label, timeoutMs });
        command.kill('SIGKILL');
        reject(new Error(`FFmpeg ${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    const clearTimer = () => clearTimeout(timer);
    command.once('end', clearTimer);
    command.once('error', (err) => {
        clearTimer();
        if (timedOut) {
            logger.debug('Ignoring FFmpeg error after timeout kill', { label, error: err.message });
        }
    });

    command.run();
}

function videoCodecFlag(codec: EncodeProfile['videoCodec']): string {
    switch (codec) {
        case 'h265':
            return 'libx265';
        case 'av1':
            return 'libaom-av1';
        case 'h264':
        default:
            return 'libx264';
    }
}

function audioCodecFlag(codec: EncodeProfile['audioCodec']): string {
    return codec === 'opus' ? 'libopus' : 'aac';
}

/**
 * Build the FFmpeg outputOptions array for a given encode profile. Pulled out
 * so it can be shared between `transcodeToMp4` and `audioToMp4`, and so it is
 * unit-testable without booting ffmpeg.
 */
export function buildEncodeOptions(profile: EncodeProfile): string[] {
    const opts: string[] = [];
    opts.push(`-c:v ${videoCodecFlag(profile.videoCodec)}`);
    opts.push(`-preset ${profile.preset}`);

    // Keep mobile compatibility for h264. h265/av1 ignore profile:baseline.
    if (profile.videoCodec === 'h264') {
        opts.push('-profile:v baseline', '-level 3.0');
    }

    if (profile.targetBitrateKbps > 0) {
        const k = profile.targetBitrateKbps;
        opts.push(`-b:v ${k}k`, `-maxrate ${Math.round(k * 1.5)}k`, `-bufsize ${k * 2}k`);
    } else {
        opts.push(`-crf ${profile.crf}`);
    }

    if (profile.maxHeight > 0) {
        // Downscale-only: only shrink if the input is taller than the cap.
        // -2 keeps the width even (required by yuv420p). Using force_original_aspect_ratio=decrease
        // is the cleanest "fit inside" for arbitrary input aspect ratios.
        opts.push(`-vf scale=-2:'min(${profile.maxHeight},ih)'`);
    }

    opts.push(`-c:a ${audioCodecFlag(profile.audioCodec)}`);
    opts.push(`-b:a ${profile.audioBitrateKbps}k`);
    opts.push('-movflags +faststart', '-pix_fmt yuv420p');
    return opts;
}

/**
 * Get media file information using ffprobe.
 * Returns container bitrate (when reported) so the Quality system can project
 * post-re-encode size without downloading the file twice.
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
            const fmtBitrate = (metadata.format as { bit_rate?: string | number }).bit_rate;
            const bitrateBps = typeof fmtBitrate === 'string' ? parseInt(fmtBitrate, 10) : fmtBitrate;
            const bitrateKbps =
                typeof bitrateBps === 'number' && Number.isFinite(bitrateBps) && bitrateBps > 0
                    ? Math.round(bitrateBps / 1000)
                    : undefined;

            resolve({
                duration: metadata.format.duration || 0,
                width: videoStream?.width,
                height: videoStream?.height,
                format: metadata.format.format_name || 'unknown',
                hasVideo: !!videoStream,
                hasAudio: !!audioStream,
                bitrateKbps,
                videoCodec: videoStream?.codec_name,
                audioCodec: audioStream?.codec_name,
            });
        });
    });
}

/**
 * Transcode video to MP4 using the supplied encode profile (or the default).
 */
export function transcodeToMp4(
    inputPath: string,
    outputPath: string,
    profile: EncodeProfile = DEFAULT_ENCODE_PROFILE
): Promise<TranscodeResult> {
    return new Promise((resolve, reject) => {
        logger.info('Starting MP4 transcode', { inputPath, outputPath, profile });

        let duration = 0;
        const opts = buildEncodeOptions(profile);

        const command = ffmpeg(inputPath)
            .outputOptions(opts)
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
                } catch {
                    // Still resolve even if we can't get duration
                    resolve({ outputPath, duration: 0 });
                }
            })
            .on('error', (err) => {
                logger.error('FFmpeg transcode error', err);
                reject(err);
            });
        runFfmpegWithTimeout(command, 'transcodeToMp4', reject);
    });
}

/**
 * Convert audio to MP4 with a static visual (for For You feed requirement)
 * Creates an MP4 container with audio + placeholder image.
 *
 * The audio side honours the supplied EncodeProfile (codec + bitrate) so an
 * operator-configured default like `audio_bitrate_kbps=64` actually applies
 * to fresh podcast ingests. The video side stays pinned to libx264 +
 * `-tune stillimage` regardless of profile — the cover is a single static
 * image, so codec choice and bitrate-mode tweaks are wasted on it. We do
 * pull the preset from the profile so a slower preset benefits the cover
 * encode too.
 */
export function audioToMp4(
    inputPath: string,
    outputPath: string,
    coverImagePath?: string,
    profile: EncodeProfile = DEFAULT_ENCODE_PROFILE
): Promise<TranscodeResult> {
    return new Promise(async (resolve, reject) => {
        logger.info('Starting audio-to-MP4 conversion', { inputPath, outputPath, profile });

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

        const command = ffmpeg()
            .input(imagePath)
            .inputOptions(['-loop 1'])  // Loop still image
            .input(inputPath)
            .outputOptions([
                // Video stays pinned — see docstring for why.
                '-c:v libx264',
                `-preset ${profile.preset}`,
                '-profile:v baseline',
                '-level 3.0',
                '-tune stillimage',       // Optimize for still image
                // Audio honours the profile.
                `-c:a ${audioCodecFlag(profile.audioCodec)}`,
                `-b:a ${profile.audioBitrateKbps}k`,
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
            });
        runFfmpegWithTimeout(command, 'audioToMp4', reject);
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
 * Extract thumbnail from video at the specified offset.
 *
 * `maxHeight` caps the thumbnail height (preserving aspect ratio); the
 * default 360 matches the historical hardcoded behaviour. `offsetSeconds`
 * picks the timecode to grab — values larger than the clip's duration cause
 * ffmpeg to fall back to the last keyframe.
 *
 * Writes to the exact outputPath provided (safe for concurrent jobs).
 */
export function extractThumbnail(
    inputPath: string,
    outputPath: string,
    offsetSeconds: number = 2,
    maxHeight: number = 360,
): Promise<string> {
    return new Promise((resolve, reject) => {
        logger.info('Extracting thumbnail', { inputPath, outputPath, offsetSeconds, maxHeight });

        // -2 keeps width even (yuv420p requirement); min(...) ensures we
        // only downscale, never upscale a small input.
        const scaleFilter = maxHeight > 0
            ? `scale=-2:'min(${maxHeight},ih)'`
            : `scale=-2:360`;

        const command = ffmpeg(inputPath)
            .seekInput(offsetSeconds)
            .outputOptions(['-vframes 1', `-vf ${scaleFilter}`])
            .output(outputPath)
            .on('end', () => {
                logger.info('Thumbnail extracted', { outputPath });
                resolve(outputPath);
            })
            .on('error', (err) => {
                logger.error('Thumbnail extraction error', err);
                reject(err);
            });
        runFfmpegWithTimeout(command, 'extractThumbnail', reject);
    });
}

/**
 * Map an output_container profile value to its file extension.
 * Restricted to single-file containers; HLS / DASH would emit a manifest +
 * segments and need a different upload path.
 */
export function containerExtension(container: string | undefined): string {
    switch ((container ?? 'mp4').toLowerCase()) {
        case 'webm': return 'webm';
        case 'mov': return 'mov';
        case 'mp4':
        default: return 'mp4';
    }
}

/**
 * Map an output_container profile value to its MIME type.
 */
export function containerMime(container: string | undefined): string {
    switch ((container ?? 'mp4').toLowerCase()) {
        case 'webm': return 'video/webm';
        case 'mov': return 'video/quicktime';
        case 'mp4':
        default: return 'video/mp4';
    }
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

        const command = ffmpeg(inputPath)
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
            });
        runFfmpegWithTimeout(command, 'extractAudio', reject);
    });
}

export function cutMediaSegment(
    inputPath: string,
    outputPath: string,
    startSec: number,
    durationSec: number,
    profile: EncodeProfile = DEFAULT_ENCODE_PROFILE
): Promise<TranscodeResult> {
    return new Promise((resolve, reject) => {
        logger.info('Cutting media segment', { inputPath, outputPath, startSec, durationSec });
        const command = ffmpeg(inputPath)
            .inputOptions([`-ss ${Math.max(0, startSec)}`])
            .duration(Math.max(0.1, durationSec))
            .outputOptions(buildEncodeOptions(profile))
            .output(outputPath)
            .on('end', async () => {
                try {
                    const info = await getMediaInfo(outputPath);
                    resolve({ outputPath, duration: info.duration });
                } catch {
                    resolve({ outputPath, duration: durationSec });
                }
            })
            .on('error', (err) => {
                logger.error('Media segment cut failed', err);
                reject(err);
            });
        runFfmpegWithTimeout(command, 'cutMediaSegment', reject);
    });
}

export function createHlsVod(
    inputPath: string,
    outputDir: string,
    playlistName = 'index.m3u8'
): Promise<{ playlistPath: string; duration: number }> {
    return new Promise(async (resolve, reject) => {
        await mkdir(outputDir, { recursive: true });
        const playlistPath = join(outputDir, playlistName);
        logger.info('Creating HLS VOD rendition', { inputPath, outputDir, playlistName });
        const command = ffmpeg(inputPath)
            .outputOptions([
                '-c copy',
                '-hls_time 6',
                '-hls_playlist_type vod',
                '-hls_segment_filename',
                join(outputDir, 'segment_%03d.ts'),
            ])
            .output(playlistPath)
            .on('end', async () => {
                try {
                    const info = await getMediaInfo(inputPath);
                    resolve({ playlistPath, duration: info.duration });
                } catch {
                    resolve({ playlistPath, duration: 0 });
                }
            })
            .on('error', (err) => {
                logger.error('HLS VOD creation failed', err);
                reject(err);
            });
        runFfmpegWithTimeout(command, 'createHlsVod', reject);
    });
}

export const transcoder = {
    getMediaInfo,
    transcodeToMp4,
    audioToMp4,
    extractThumbnail,
    extractAudio,
    cutMediaSegment,
    createHlsVod,
};
