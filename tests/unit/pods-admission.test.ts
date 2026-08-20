import { describe, expect, it } from 'vitest';
import {
    PODS_MIN_DURATION_SEC,
    configuredMaximumDurationSec,
    configuredResultLimit,
    configuredMinimumDurationSec,
    hasAuthoritativeDurationVerification,
    knownDurationAdmissionFailure,
} from '../../src/services/pods-admission.js';

describe('Pods admission contract', () => {
    it('rejects known undersized Video and Podcast media but allows unknown duration for later probing', () => {
        expect(knownDurationAdmissionFailure('VIDEO', PODS_MIN_DURATION_SEC - 1)).toBe('media_duration_below_pods_minimum');
        expect(knownDurationAdmissionFailure('PODCAST', 0)).toBe('media_duration_invalid');
        expect(knownDurationAdmissionFailure('VIDEO', Number.NaN)).toBe('media_duration_invalid');
        expect(knownDurationAdmissionFailure('VIDEO', Number.POSITIVE_INFINITY)).toBe('media_duration_invalid');
        expect(knownDurationAdmissionFailure('VIDEO', undefined)).toBeUndefined();
        expect(knownDurationAdmissionFailure('VIDEO', PODS_MIN_DURATION_SEC)).toBeUndefined();
        expect(knownDurationAdmissionFailure('VIDEO', 2400)).toBeUndefined();
        expect(knownDurationAdmissionFailure('VIDEO', 2401)).toBeUndefined();
        expect(knownDurationAdmissionFailure('NEWS', 1)).toBeUndefined();
    });

    it('trusts only a matching persisted FFprobe verification', () => {
        expect(hasAuthoritativeDurationVerification({ duration_verification: { source: 'ffprobe', duration_sec: 270 } }, 270)).toBe(true);
        expect(hasAuthoritativeDurationVerification({ duration_verification: { source: 'provider', duration_sec: 270 } }, 270)).toBe(false);
        expect(hasAuthoritativeDurationVerification({ duration_verification: { source: 'ffprobe', duration_sec: 271 } }, 270)).toBe(false);
        expect(hasAuthoritativeDurationVerification({}, 270)).toBe(false);
        expect(hasAuthoritativeDurationVerification({ duration_verification: { source: 'ffprobe', duration_sec: 270 } }, null)).toBe(false);
    });

    it('normalizes seconds and minutes aliases without allowing a weaker floor', () => {
        expect(configuredMinimumDurationSec({ min_duration_sec: 120 })).toBe(PODS_MIN_DURATION_SEC);
        expect(configuredMinimumDurationSec({ minDurationMinutes: 8 })).toBe(480);
        expect(configuredMinimumDurationSec({ minDurationSec: 300, min_duration_minutes: 8 })).toBe(480);
        expect(configuredMinimumDurationSec({ min_duration_minutes: '7.5' })).toBe(450);
    });

    it('normalizes optional maximum aliases without inventing a product maximum', () => {
        expect(configuredMaximumDurationSec({})).toBeUndefined();
        expect(configuredMaximumDurationSec({ max_duration_sec: '2400' })).toBe(2400);
        expect(configuredMaximumDurationSec({ maxDurationMinutes: 30 })).toBe(1800);
    });

    it('normalizes accepted-item limits and enforces the provider cap', () => {
        expect(configuredResultLimit({ max_results: '20' }, 10, 50)).toBe(20);
        expect(configuredResultLimit({ maxResults: 500 }, 10, 50)).toBe(50);
        expect(configuredResultLimit({}, 10, 50)).toBe(10);
    });
});
