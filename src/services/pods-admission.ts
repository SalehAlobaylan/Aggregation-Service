/** Canonical admission contract for raw Pods parents. */
export const PODS_MIN_DURATION_SEC = 270;
export const PODS_MAX_RAW_PARENT_DURATION_SEC = 2400;

export function isPodsContentType(type: string): boolean {
  return type === 'VIDEO' || type === 'PODCAST';
}

/** Provider metadata is advisory; only known-invalid durations are rejected here. */
export function knownDurationAdmissionFailure(type: string, durationSec: number | null | undefined): string | undefined {
  if (!isPodsContentType(type) || durationSec == null) return undefined;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 'media_duration_invalid';
  if (durationSec < PODS_MIN_DURATION_SEC) return 'media_duration_below_pods_minimum';
  // Long parents are valid. CMS owns their later atomization/hiding decision.
  return undefined;
}

/** Only a persisted FFprobe result can authorize an existing Pods artifact. */
export function hasAuthoritativeDurationVerification(
  metadata: Record<string, unknown> | null | undefined,
  durationSec: number | null | undefined,
): boolean {
  if (durationSec == null || !Number.isInteger(durationSec)) return false;
  const verification = metadata?.duration_verification;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) return false;
  const record = verification as Record<string, unknown>;
  return record.source === 'ffprobe' && record.duration_sec === durationSec;
}

/** Canonicalize provider aliases at the adapter boundary, always in seconds. */
export function configuredMinimumDurationSec(settings: Record<string, unknown> | undefined): number {
  const raw = settings ?? {};
  const seconds = raw.min_duration_sec ?? raw.minDurationSec;
  const minutes = raw.min_duration_minutes ?? raw.minDurationMinutes;
  const candidates = [
    numericSetting(seconds),
    numericSetting(minutes) * 60,
    PODS_MIN_DURATION_SEC,
  ];
  return Math.floor(Math.max(...candidates));
}

export function configuredMaximumDurationSec(settings: Record<string, unknown> | undefined): number | undefined {
  const raw = settings ?? {};
  const seconds = numericSetting(raw.max_duration_sec ?? raw.maxDurationSec);
  const minutes = numericSetting(raw.max_duration_minutes ?? raw.maxDurationMinutes) * 60;
  const maximum = Math.max(seconds, minutes);
  return maximum > 0 ? Math.floor(maximum) : undefined;
}

export function configuredResultLimit(settings: Record<string, unknown> | undefined, fallback: number, cap: number): number {
  const raw = settings ?? {};
  const configured = numericSetting(raw.max_results ?? raw.maxResults);
  return configured > 0 ? Math.min(cap, Math.floor(configured)) : fallback;
}

function numericSetting(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
