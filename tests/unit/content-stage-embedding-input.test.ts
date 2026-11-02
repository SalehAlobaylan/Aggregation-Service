import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Processor = (job: unknown, logger: unknown) => Promise<void>;
const mocks = vi.hoisted(() => ({
  createWorker: vi.fn((definition: { processor: Processor }) => definition),
  beginContentStage: vi.fn(),
  heartbeatContentStage: vi.fn(),
  failContentStage: vi.fn(),
  uncertainContentStage: vi.fn(),
  generateEmbeddingViaEnrichment: vi.fn(),
  generateMetadataViaEnrichment: vi.fn(),
}));
vi.mock('../../src/workers/base-worker.js', () => ({ createWorker: mocks.createWorker }));
vi.mock('../../src/cms/client.js', () => ({
  cmsClient: mocks,
  contentStageCorrelation: (claim: { request_id: string }) => ({ request_id: claim.request_id }),
  isStaleContentStageDeliveryError: () => false,
}));
vi.mock('../../src/ai/enrichment-client.js', () => ({
  EnrichmentRequestError: class extends Error {},
  generateEmbeddingViaEnrichment: mocks.generateEmbeddingViaEnrichment,
  generateMetadataViaEnrichment: mocks.generateMetadataViaEnrichment,
}));
vi.mock('../../src/observability/logger.js', () => ({ createLogger: vi.fn() }));
vi.mock('../../src/queues/index.js', () => ({ QUEUE_NAMES: {
  NEWS_ENRICHMENT: 'news', NEWS_OPTIONAL: 'news-optional', PODS_COMPLETION: 'pods',
  PODS_OPTIONAL: 'pods-optional', NEWS_STAGE_DLQ: 'news-dlq', PODS_STAGE_DLQ: 'pods-dlq',
} }));

import { createNewsEnrichmentWorker, createPodsOptionalWorker } from '../../src/workers/content-stage-embedding.worker.js';

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateEmbeddingViaEnrichment.mockResolvedValue({ writeBackStatus: 'ok' });
});

async function runEmbedding(stage: 'news_text_embedding' | 'pods_caption_reembedding', input: Record<string, string>) {
  if (stage === 'news_text_embedding') createNewsEnrichmentWorker();
  else createPodsOptionalWorker();
  const definition = mocks.createWorker.mock.calls.at(-1)![0];
  await definition.processor({ id: 'delivery-1', data: { claim: {
    stage, lane: stage === 'news_text_embedding' ? 'news' : 'pods',
    request_id: 'request-1', content_item_id: 'item-1', tenant_id: 'tenant-1', bounded_input: input,
  } } }, logger);
  expect(mocks.failContentStage).not.toHaveBeenCalled();
  expect(mocks.uncertainContentStage).not.toHaveBeenCalled();
  expect(mocks.generateEmbeddingViaEnrichment).toHaveBeenCalledOnce();
  return mocks.generateEmbeddingViaEnrichment.mock.calls[0];
}

describe('durable embedding worker canonical input', () => {
  it('uses the shared metadata recipe for News', async () => {
    const fixtures = JSON.parse(readFileSync(new URL('../../../Content-Management-System/testdata/embedding-input.json', import.meta.url), 'utf8'));
    const row = fixtures[0];
    const call = await runEmbedding('news_text_embedding', { title: row.title, excerpt: row.excerpt, body_text: row.body });
    expect(call[0]).toBe(row.expected);
    expect(call[2]).toMatchObject({ lane: 'news', contentStage: { request_id: 'request-1' } });
  });

  it('embeds title, caption, cleaned body and excerpt for the caption stage', async () => {
    const fixtures = JSON.parse(readFileSync(new URL('../../../Content-Management-System/testdata/embedding-input.json', import.meta.url), 'utf8'));
    const row = fixtures[1];
    const call = await runEmbedding('pods_caption_reembedding', { title: row.title, excerpt: row.excerpt, body_text: row.body, caption_text: row.transcript });
    expect(call[0]).toBe(row.expected);
    expect(call[2]).toMatchObject({ lane: 'pods', contentStage: { request_id: 'request-1' } });
  });

  it('caps the actual caption input while preserving metadata and Unicode', async () => {
    const call = await runEmbedding('pods_caption_reembedding', {
      title: 'حلقة 😀', caption_text: 'ن'.repeat(12_000),
      body_text: 'وصف https://example.test/noise', excerpt: 'مقدمة',
    });
    expect(call[0]).toBe(`حلقة 😀 ${'ن'.repeat(3000)} وصف مقدمة`);
  });
});
