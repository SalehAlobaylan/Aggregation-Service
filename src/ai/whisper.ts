/**
 * Whisper Transcription Client
 * HTTP client for Whisper ASR sidecar service
 */
import FormData from 'form-data';
import { createReadStream } from 'fs';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';

export interface TranscriptResult {
    text: string;
    language?: string;
    segments?: TranscriptSegment[];
}

export interface TranscriptSegment {
    start: number;
    end: number;
    text: string;
}

/**
 * Transcribe audio file using Whisper ASR sidecar
 */
export async function transcribe(audioPath: string): Promise<TranscriptResult> {
    logger.info('Starting Whisper transcription', { audioPath });

    const form = new FormData();
    form.append('audio_file', createReadStream(audioPath));

    try {
        // The onerahmet/openai-whisper-asr-webservice uses /asr endpoint
        const response = await fetch(`${config.whisperApiUrl}/asr`, {
            method: 'POST',
            body: form as unknown as BodyInit,
            headers: {
                ...form.getHeaders(),
            },
            // Long timeout for transcription (up to 10 minutes for long audio)
            signal: AbortSignal.timeout(600000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
        }

        // Response format depends on output parameter
        // Default is plain text, but we want segments if available
        const result = await response.text();

        logger.info('Whisper transcription complete', {
            audioPath,
            textLength: result.length,
        });

        return {
            text: result.trim(),
        };
    } catch (error) {
        logger.error('Whisper transcription failed', error, { audioPath });
        throw error;
    }
}

/**
 * Transcribe with word-level timestamps (if supported)
 */
export async function transcribeWithTimestamps(
    audioPath: string
): Promise<TranscriptResult> {
    logger.info('Starting Whisper transcription with timestamps', { audioPath });

    const form = new FormData();
    form.append('audio_file', createReadStream(audioPath));

    try {
        // Request JSON output with timestamps
        const response = await fetch(
            `${config.whisperApiUrl}/asr?output=json&word_timestamps=true`,
            {
                method: 'POST',
                body: form as unknown as BodyInit,
                headers: {
                    ...form.getHeaders(),
                },
                signal: AbortSignal.timeout(600000),
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
        }

        const result = await response.json() as {
            text?: string;
            language?: string;
            segments?: Array<{
                start: number;
                end: number;
                text: string;
            }>;
        };

        logger.info('Whisper transcription with timestamps complete', {
            audioPath,
            textLength: result.text?.length || 0,
            segmentCount: result.segments?.length || 0,
            language: result.language,
        });

        return {
            text: result.text || '',
            language: result.language,
            segments: result.segments?.map((s) => ({
                start: s.start,
                end: s.end,
                text: s.text,
            })),
        };
    } catch (error) {
        // Fall back to simple transcription if timestamps not supported
        logger.warn('Timestamps not available, falling back to simple transcription', {
            audioPath,
            error: (error as Error).message,
        });
        return transcribe(audioPath);
    }
}

/**
 * Detect language of audio file
 */
export async function detectLanguage(audioPath: string): Promise<string> {
    const form = new FormData();
    form.append('audio_file', createReadStream(audioPath));

    try {
        const response = await fetch(
            `${config.whisperApiUrl}/detect-language`,
            {
                method: 'POST',
                body: form as unknown as BodyInit,
                headers: {
                    ...form.getHeaders(),
                },
                signal: AbortSignal.timeout(60000),
            }
        );

        if (!response.ok) {
            throw new Error(`Language detection failed: ${response.status}`);
        }

        const result = await response.json() as { detected_language?: string; language?: string };
        return result.detected_language || result.language || 'en';
    } catch (error) {
        logger.warn('Language detection failed, defaulting to English', { error });
        return 'en';
    }
}

export const whisperClient = {
    transcribe,
    transcribeWithTimestamps,
    detectLanguage,
};
