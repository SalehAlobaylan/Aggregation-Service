import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FetchResult, RawFetchedItem } from '../fetchers/types.js';

const instant = z.string().datetime({ offset: true });
const identity = z.string().uuid().refine((value) => value !== '00000000-0000-0000-0000-000000000000', 'Replay identity must be nonzero');
const specSchema = z.object({
  version: z.literal('content-reset-page/v1'),
  providerContract: z.string(),
  sourceType: z.enum(['PODCAST', 'REDDIT']),
  configVersion: z.number().int().positive(),
  configHash: z.string().regex(/^[0-9a-f]{64}$/),
  mode: z.enum(['bounded_recent', 'available_history']),
  windowStart: instant.optional(),
  windowEnd: instant,
  maxPages: z.number().int().min(1).max(100),
  maxItems: z.number().int().min(1).max(100),
  maxBytes: z.number().int().min(1).max(8 * 1024 * 1024),
}).strict().superRefine((spec, ctx) => {
  if (spec.providerContract !== `${spec.sourceType}:reset-page/v1`) {
    ctx.addIssue({ code: 'custom', message: 'Provider replay-page contract mismatch' });
  }
  if (spec.mode === 'bounded_recent') {
    const span = Date.parse(spec.windowEnd) - Date.parse(spec.windowStart ?? '');
    if (!Number.isFinite(span) || span <= 0 || span > 365 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({ code: 'custom', message: 'Replay date interval is invalid' });
    }
  } else if (spec.windowStart !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'Available-history replay cannot claim a lower date bound' });
  }
});

export function canonicalReplayHash(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
    }
    return input;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

export const contentResetReplayContextSchema = z.object({
  campaignId: identity,
  revisionId: identity,
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  branchId: identity,
  pageId: identity,
  ordinal: z.number().int().positive(),
  specHash: z.string().regex(/^[0-9a-f]{64}$/),
  inputCursor: z.string().max(4096),
  spec: specSchema,
}).strict().superRefine((page, ctx) => {
  if (page.ordinal > page.spec.maxPages || page.specHash !== canonicalReplayHash(page.spec) ||
      Buffer.byteLength(page.inputCursor, 'utf8') > 4096 ||
      (page.ordinal === 1 ? page.inputCursor !== '' : page.inputCursor === '')) {
    ctx.addIssue({ code: 'custom', message: 'Replay page identity or bounds mismatch' });
  }
});

export type ContentResetReplayContext = z.infer<typeof contentResetReplayContextSchema>;

export function contentResetReplayFromMetadata(metadata: Record<string, unknown>): ContentResetReplayContext {
  const page = metadata.content_reset_replay;
  if (!page || typeof page !== 'object' || Array.isArray(page)) throw new Error('CMS replay request lacks its durable page binding');
  return contentResetReplayContextSchema.parse({
    ...page,
    campaignId: metadata.content_reset_campaign_id,
    revisionId: metadata.content_reset_revision_id,
    manifestHash: metadata.content_reset_manifest_hash,
  });
}

export class ReplayPageIncomplete extends Error {
  constructor(readonly reasonCode: string) { super(reasonCode); }
}

// Validate the complete returned page before observations, normalize admission
// or continuation. A truncated page cannot provide a trustworthy next cursor.
export function planContentResetReplayPage(page: ContentResetReplayContext, result: FetchResult): {
  items: RawFetchedItem[];
  evidence: Record<string, unknown>;
} {
  contentResetReplayContextSchema.parse(page);
  const bytes = Buffer.byteLength(JSON.stringify(result.items), 'utf8');
  if (result.items.length > page.spec.maxItems || bytes > page.spec.maxBytes) throw new ReplayPageIncomplete('replay_page_budget_exceeded');
  if (result.metadata.truncated || result.metadata.unavailable || result.metadata.errors !== 0 || result.metadata.skipped !== 0 || result.metadata.totalFetched !== result.items.length) throw new ReplayPageIncomplete('replay_provider_page_incomplete');
  if (result.hasMore && (!result.cursor || result.cursor === page.inputCursor || Buffer.byteLength(result.cursor, 'utf8') > 4096)) throw new ReplayPageIncomplete('replay_continuation_invalid');
  const ids = new Set<string>();
  const start = page.spec.windowStart ? Date.parse(page.spec.windowStart) : undefined;
  const end = Date.parse(page.spec.windowEnd);
  const items = result.items.filter((item) => {
    // CMS identities are limited in UTF-8 bytes and trim whitespace at ingest.
    // Reject aliases here before provider observations or normalize admission.
    if (!item.externalId || item.externalId !== item.externalId.trim() || Buffer.byteLength(item.externalId, 'utf8') > 255 || ids.has(item.externalId) || item.sourceType !== page.spec.sourceType) throw new ReplayPageIncomplete('replay_item_identity_invalid');
    ids.add(item.externalId);
    const date = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    // Both modes freeze an upper boundary. Undated items cannot prove they
    // belong before it; a future observed-boundary adapter needs a new contract.
    if (!Number.isFinite(date)) throw new ReplayPageIncomplete('replay_publication_date_unknown');
    return date < end && (start === undefined || date >= start);
  });
  return { items, evidence: {
    branch_id: page.branchId, page_id: page.pageId, spec_hash: page.specHash,
    complete: true, observed: result.items.length, admitted: items.length,
    outside_window: result.items.length - items.length, observed_bytes: bytes,
    next_cursor: result.hasMore ? result.cursor! : '', exhausted: !result.hasMore,
  } };
}
