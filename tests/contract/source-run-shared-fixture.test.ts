import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SOURCE_RUN_CONTRACT_VERSION,
  deterministicSourceRunUnitJobId,
  sourceRunManifestChildDigest,
  sourceRunReceiptCapability,
  sourceRunReceiptSchema,
  sourceRunTerminalOutcomeCategory,
} from '../../src/contracts/source-runs.js';

const fixture = JSON.parse(readFileSync(resolve(process.cwd(), '../contracts/source-run-v1-fixtures.json'), 'utf8')) as Record<string, any>;

describe('shared source-run/v1 fixture', () => {
  it('matches Aggregation contract identities, capabilities, outcomes, and receipt bytes', () => {
    expect(fixture.contract_version).toBe(SOURCE_RUN_CONTRACT_VERSION);
    expect(fixture.receipt_capabilities).toEqual(sourceRunReceiptCapability);
    expect(fixture.terminal_outcomes).toEqual(sourceRunTerminalOutcomeCategory);
    const identity = fixture.identity_fixture;
    expect(deterministicSourceRunUnitJobId({ tenantId: identity.tenant_id, sourceRunRequestId: identity.request_id, sourceRunAttemptId: identity.attempt_id, executionUnitId: identity.unit_id, attemptFenceToken: identity.fence })).toBe(identity.expected_job_id);
    expect(sourceRunManifestChildDigest(fixture.manifest_fixture.unit_keys)).toBe(fixture.manifest_fixture.expected_digest);
    expect(sourceRunReceiptSchema.parse(fixture.receipt_fixture)).toEqual(fixture.receipt_fixture);
  });
});
