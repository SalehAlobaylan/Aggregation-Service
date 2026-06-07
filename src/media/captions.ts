/**
 * YouTube caption + chapter extraction.
 *
 * yt-dlp already writes `--write-info-json` (chapters + caption manifest) and,
 * with the subtitle flags, the caption `.vtt` files. This module reads those
 * off disk — no extra network calls. It:
 *   - extracts native YouTube chapters,
 *   - picks the best caption track (human preferred; original-language auto as
 *     fallback; auto-TRANSLATED tracks rejected — for Arabic they're garbage),
 *   - parses the VTT into [{start,end,text}] segments and normalizes the
 *     rolling-duplicate lines + inline <c> word-timing tags that auto-captions
 *     emit.
 */
import { readFile, unlink, readdir } from 'fs/promises';
import { dirname, basename, join } from 'path';
import { logger } from '../observability/logger.js';
import type { TranscriptSegment, TranscriptChapter } from '../cms/types.js';

// Caption languages we accept, in priority order. Arabic first (primary
// content), then English. Variants (ar-SA, en-US, …) match by prefix.
const ACCEPTED_LANGS = ['ar', 'en'];

export interface ExtractedCaptions {
    segments: TranscriptSegment[];
    language: string;
    /** true = YouTube auto-generated (weak; upgradeable), false = human. */
    isAuto: boolean;
}

export interface CaptionExtractionResult {
    captions?: ExtractedCaptions;
    chapters: TranscriptChapter[];
}

interface YtSubtitleEntry {
    ext?: string;
    url?: string;
    name?: string;
    filepath?: string;
}

interface YtInfoJson {
    chapters?: { start_time?: number; end_time?: number; title?: string }[];
    subtitles?: Record<string, YtSubtitleEntry[]>;
    automatic_captions?: Record<string, YtSubtitleEntry[]>;
    requested_subtitles?: Record<string, YtSubtitleEntry>;
}

/**
 * Read the info-json + caption files yt-dlp wrote and return chapters + the
 * best caption track. Never throws — returns empty chapters / no captions on
 * any problem so it can't break the download pipeline. Best-effort deletes the
 * transient .info.json + .vtt files it consumed.
 */
export async function extractCaptionsAndChapters(
    infoJsonPath: string,
): Promise<CaptionExtractionResult> {
    const aux: string[] = [infoJsonPath];
    try {
        const raw = await readFile(infoJsonPath, 'utf-8');
        const info = JSON.parse(raw) as YtInfoJson;

        const chapters = extractChapters(info);
        const captionsResult = await selectAndParseCaption(info, infoJsonPath, aux);

        return { captions: captionsResult, chapters };
    } catch (err) {
        logger.debug('Caption/chapter extraction skipped', {
            infoJsonPath,
            error: err instanceof Error ? err.message : 'unknown',
        });
        return { chapters: [] };
    } finally {
        await cleanup(aux);
    }
}

function extractChapters(info: YtInfoJson): TranscriptChapter[] {
    if (!Array.isArray(info.chapters)) return [];
    return info.chapters
        .filter((c) => typeof c.title === 'string' && c.title.trim().length > 0)
        .map((c) => ({
            start: Number(c.start_time ?? 0),
            end: Number(c.end_time ?? 0),
            title: String(c.title).trim(),
            source: 'youtube' as const,
        }));
}

/**
 * Pick the best caption track per the human > original-auto rules, locate its
 * .vtt on disk, parse + normalize it.
 */
async function selectAndParseCaption(
    info: YtInfoJson,
    infoJsonPath: string,
    aux: string[],
): Promise<ExtractedCaptions | undefined> {
    const dir = dirname(infoJsonPath);
    // baseName: strip the trailing ".info.json" to get the yt-dlp output stem.
    const stem = basename(infoJsonPath).replace(/\.info\.json$/, '');

    const subtitles = info.subtitles ?? {};
    const autoCaptions = info.automatic_captions ?? {};

    for (const lang of ACCEPTED_LANGS) {
        // Human caption first.
        const humanKey = matchLangKey(subtitles, lang);
        if (humanKey) {
            const file = await findVttFile(dir, stem, humanKey, info);
            if (file) {
                const segments = parseAndNormalizeVtt(await readFile(file, 'utf-8'), false);
                aux.push(file);
                if (segments.length > 0) {
                    return { segments, language: lang, isAuto: false };
                }
            }
        }
    }

    for (const lang of ACCEPTED_LANGS) {
        // Original-language auto caption — reject machine-translated tracks.
        const autoKey = matchLangKey(autoCaptions, lang);
        if (autoKey && !isTranslatedTrack(autoCaptions[autoKey])) {
            const file = await findVttFile(dir, stem, autoKey, info);
            if (file) {
                const segments = parseAndNormalizeVtt(await readFile(file, 'utf-8'), true);
                aux.push(file);
                if (segments.length > 0) {
                    return { segments, language: lang, isAuto: true };
                }
            }
        }
    }

    return undefined;
}

/** Find a track key matching the language by prefix (ar, ar-SA, ar-orig…). */
function matchLangKey(tracks: Record<string, unknown>, lang: string): string | undefined {
    const keys = Object.keys(tracks);
    // Exact first, then prefix.
    return keys.find((k) => k === lang) ?? keys.find((k) => k.toLowerCase().startsWith(lang + '-')) ?? keys.find((k) => k.toLowerCase().startsWith(lang));
}

/**
 * Auto-translated tracks carry a `tlang=` query param in their fetch URL (and
 * often a "from <lang>" name). These are ASR-of-one-language machine-translated
 * to another — rejected.
 */
function isTranslatedTrack(entries: YtSubtitleEntry[] | undefined): boolean {
    if (!Array.isArray(entries)) return false;
    return entries.every((e) => {
        const url = e.url ?? '';
        const name = (e.name ?? '').toLowerCase();
        return url.includes('tlang=') || name.includes('from ');
    });
}

/**
 * Locate the .vtt file yt-dlp wrote for a track. Prefer the exact filepath from
 * requested_subtitles; otherwise scan the dir for `<stem>.<lang>*.vtt`.
 */
async function findVttFile(
    dir: string,
    stem: string,
    langKey: string,
    info: YtInfoJson,
): Promise<string | undefined> {
    const requested = info.requested_subtitles?.[langKey];
    if (requested?.filepath) return requested.filepath;

    try {
        const files = await readdir(dir);
        const prefix = `${stem}.${langKey}`;
        const match =
            files.find((f) => f === `${stem}.${langKey}.vtt`) ??
            files.find((f) => f.startsWith(prefix) && f.endsWith('.vtt')) ??
            // langKey may be 'ar' but file is 'ar-orig.vtt' etc.
            files.find((f) => f.startsWith(`${stem}.${langKey.split('-')[0]}`) && f.endsWith('.vtt'));
        return match ? join(dir, match) : undefined;
    } catch {
        return undefined;
    }
}

// ─── VTT parsing + normalization ────────────────────────────────────────────

const TIMESTAMP_RE =
    /(\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*(\d{2}:)?\d{2}:\d{2}[.,]\d{3}/;

/**
 * Parse WebVTT into segments. For auto-captions, strip inline `<c>`/timestamp
 * tags and drop the rolling-duplicate lines YouTube emits (each line appears
 * once mid-scroll and again when finalized).
 */
export function parseAndNormalizeVtt(vtt: string, isAuto: boolean): TranscriptSegment[] {
    const lines = vtt.split(/\r?\n/);
    const raw: TranscriptSegment[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (TIMESTAMP_RE.test(line)) {
            const [startStr, endStr] = line.split('-->').map((s) => s.trim().split(' ')[0]);
            const start = parseTimestamp(startStr);
            const end = parseTimestamp(endStr);
            i++;
            const textLines: string[] = [];
            while (i < lines.length && lines[i].trim() !== '' && !TIMESTAMP_RE.test(lines[i])) {
                textLines.push(lines[i]);
                i++;
            }
            const text = stripTags(textLines.join(' '));
            if (text) raw.push({ start, end, text });
        } else {
            i++;
        }
    }

    return isAuto ? dedupeRolling(raw) : dedupeConsecutive(raw);
}

/** Strip `<c>`, `<00:00:00.000>` inline tags, HTML entities, collapse spaces. */
function stripTags(s: string): string {
    return s
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Drop a segment whose text equals the previous one's (human caption safety). */
function dedupeConsecutive(segs: TranscriptSegment[]): TranscriptSegment[] {
    const out: TranscriptSegment[] = [];
    for (const s of segs) {
        const prev = out[out.length - 1];
        if (prev && prev.text === s.text) {
            prev.end = s.end; // extend
            continue;
        }
        out.push({ ...s });
    }
    return out;
}

/**
 * Collapse YouTube auto-caption rolling duplicates: consecutive cues where one
 * is a prefix/continuation of the next are merged into the longer line.
 */
function dedupeRolling(segs: TranscriptSegment[]): TranscriptSegment[] {
    const out: TranscriptSegment[] = [];
    for (const s of segs) {
        const prev = out[out.length - 1];
        if (prev) {
            if (s.text === prev.text) {
                prev.end = s.end;
                continue;
            }
            // current continues previous (rolling window): replace with the longer.
            if (s.text.startsWith(prev.text)) {
                prev.text = s.text;
                prev.end = s.end;
                continue;
            }
            if (prev.text.startsWith(s.text)) {
                prev.end = s.end;
                continue;
            }
        }
        out.push({ ...s });
    }
    return out;
}

/** Parse `HH:MM:SS.mmm` or `MM:SS.mmm` (comma or dot) → seconds. */
function parseTimestamp(ts: string): number {
    const clean = ts.replace(',', '.');
    const parts = clean.split(':').map(Number);
    let seconds = 0;
    for (const p of parts) seconds = seconds * 60 + p;
    return Math.round(seconds * 1000) / 1000;
}

async function cleanup(paths: string[]): Promise<void> {
    for (const p of paths) {
        try {
            await unlink(p);
        } catch {
            /* best-effort */
        }
    }
}

/** Join caption segments into the transcript full_text. */
export function captionsToFullText(segments: TranscriptSegment[]): string {
    return segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
}
