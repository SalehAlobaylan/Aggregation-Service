import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalReplayHash, contentResetReplayContextSchema, contentResetReplayFromMetadata, planContentResetReplayPage } from '../../src/contracts/content-reset-replay.js';
import type { FetchResult, RawFetchedItem } from '../../src/fetchers/types.js';

const fixture = JSON.parse(readFileSync(resolve(process.cwd(), '../contracts/content-reset-page-v1-fixtures.json'), 'utf8'));
const page = contentResetReplayContextSchema.parse(fixture.page);
function item(id: string, date?: string): RawFetchedItem {
  return { externalId: id, sourceType: 'REDDIT', url: 'https://example.test/item', title: id, metadata: {}, fetchedAt: '2026-09-29T00:00:00Z', publishedAt: date };
}
function result(items: RawFetchedItem[], more = false, cursor?: string): FetchResult {
  return { items, hasMore: more, cursor, metadata: { totalFetched: items.length, skipped: 0, errors: 0 } };
}

describe('bounded Content Reset replay', () => {
  it('shares exact spec bytes with CMS and requires a durable page binding', () => {
    expect(canonicalReplayHash(page.spec)).toBe(fixture.page.specHash);
    expect(() => contentResetReplayFromMetadata({ content_reset_campaign_id: page.campaignId, content_reset_revision_id: page.revisionId, content_reset_manifest_hash: page.manifestHash })).toThrow('durable page binding');
    expect(() => contentResetReplayContextSchema.parse({ ...page, spec: { ...page.spec, maxItems: 101 } })).toThrow();
    expect(() => contentResetReplayContextSchema.parse({ ...page, ordinal: 2 })).toThrow();
  });

  it('uses an inclusive lower and exclusive upper date bound while retaining continuation', () => {
    const plan = planContentResetReplayPage(page, result([
      item('before', '2026-08-31T23:59:59Z'), item('start', page.spec.windowStart),
      item('inside', '2026-09-28T23:59:59Z'), item('end', page.spec.windowEnd),
    ], true, 'opaque:not-sortable'));
    expect(plan.items.map((entry) => entry.externalId)).toEqual(['start', 'inside']);
    expect(plan.evidence).toMatchObject({ complete: true, observed: 4, admitted: 2, outside_window: 2, next_cursor: 'opaque:not-sortable', exhausted: false });
  });

  it.each([undefined, 'bad-date'])('blocks date replay with unknown dates (%s)', (date) => {
    expect(() => planContentResetReplayPage(page, result([item('unknown', date)]))).toThrow('replay_publication_date_unknown');
  });

  it('rejects overflow instead of slicing a page and advancing its cursor', () => {
    expect(() => planContentResetReplayPage(page, result(Array.from({ length: 101 }, (_, i) => item(String(i), '2026-09-15T00:00:00Z')), true, 'next'))).toThrow('replay_page_budget_exceeded');
    const huge = item('huge', '2026-09-15T00:00:00Z'); huge.content = 'x'.repeat(page.spec.maxBytes);
    expect(() => planContentResetReplayPage(page, result([huge]))).toThrow('replay_page_budget_exceeded');
  });

  it('rejects missing continuation, repeated cursors, duplicate identities and partial provider output', () => {
    expect(() => planContentResetReplayPage(page, result([], true))).toThrow('replay_continuation_invalid');
    const continuation = { ...page, ordinal: 2, inputCursor: 'same' };
    expect(() => planContentResetReplayPage(continuation, result([], true, 'same'))).toThrow('replay_continuation_invalid');
    expect(() => planContentResetReplayPage(page, result([item('dup', '2026-09-15T00:00:00Z'), item('dup', '2026-09-15T00:00:00Z')]))).toThrow('replay_item_identity_invalid');
    const partial = result([]); partial.metadata.skipped = 1;
    expect(() => planContentResetReplayPage(page, partial)).toThrow('replay_provider_page_incomplete');
  });

  it('distinguishes an empty complete page from an unknown provider result', () => {
    expect(planContentResetReplayPage(page, result([])).evidence).toMatchObject({ complete: true, exhausted: true, observed: 0, admitted: 0 });
    const unavailable = result([]); unavailable.metadata.errors = 1;
    expect(() => planContentResetReplayPage(page, unavailable)).toThrow('replay_provider_page_incomplete');
    for (const flag of ['truncated', 'unavailable'] as const) {
      const incomplete = result([]); incomplete.metadata[flag] = true;
      expect(() => planContentResetReplayPage(page, incomplete)).toThrow('replay_provider_page_incomplete');
    }
  });

  it('matches CMS byte limits and rejects whitespace aliases and nil identities', () => {
    expect(() => contentResetReplayContextSchema.parse({ ...page, pageId: '00000000-0000-0000-0000-000000000000' })).toThrow();
    for (const id of [' item ', 'ع'.repeat(128), '😀'.repeat(64)]) {
      expect(() => planContentResetReplayPage(page, result([item(id, '2026-09-15T00:00:00Z')]))).toThrow('replay_item_identity_invalid');
    }
    expect(planContentResetReplayPage(page, result([item('ع'.repeat(127), '2026-09-15T00:00:00Z')])).items).toHaveLength(1);
  });

  it('does not treat undated available-history entries as belonging before the frozen boundary', () => {
    const { windowStart: _start, ...withoutStart } = page.spec;
    const spec = { ...withoutStart, mode: 'available_history' as const };
    const history = { ...page, spec, specHash: canonicalReplayHash(spec) };
    expect(() => planContentResetReplayPage(history, result([item('unknown')]))).toThrow('replay_publication_date_unknown');
  });
});
