import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createWorker: vi.fn((definition) => definition) }));

vi.mock('../../src/workers/base-worker.js', () => ({ createWorker: mocks.createWorker }));
vi.mock('../../src/cms/client.js', () => ({ cmsClient: {}, contentStageCorrelation: vi.fn() }));
vi.mock('../../src/ai/embeddings.js', () => ({ buildEmbeddingText: vi.fn() }));
vi.mock('../../src/ai/enrichment-client.js', () => ({ EnrichmentRequestError: class extends Error {}, generateEmbeddingViaEnrichment: vi.fn() }));
vi.mock('../../src/observability/logger.js', () => ({ createLogger: vi.fn() }));
vi.mock('../../src/queues/index.js', () => ({ QUEUE_NAMES: { NEWS_ENRICHMENT: 'news-enrichment-queue', NEWS_OPTIONAL: 'news-optional-queue', PODS_COMPLETION: 'pods-completion-queue', PODS_OPTIONAL: 'pods-optional-queue', NEWS_STAGE_DLQ: 'news-stage-dlq', PODS_STAGE_DLQ: 'pods-stage-dlq' } }));

describe('content-stage worker construction', () => {
	beforeEach(() => vi.clearAllMocks());

	it('does not subscribe either lane merely by importing the module', async () => {
		await import('../../src/workers/content-stage-embedding.worker.js');
		expect(mocks.createWorker).not.toHaveBeenCalled();
	});

	it('constructs exactly the selected News lane worker', async () => {
		const { createNewsEnrichmentWorker } = await import('../../src/workers/content-stage-embedding.worker.js');
		createNewsEnrichmentWorker();
		expect(mocks.createWorker).toHaveBeenCalledTimes(1);
		expect(mocks.createWorker.mock.calls[0]?.[0]).toMatchObject({ queueName: 'news-enrichment-queue', deadLetterQueueName: 'news-stage-dlq' });
	});

	it('keeps optional News work on a separate worker queue', async () => {
		const { createNewsOptionalWorker } = await import('../../src/workers/content-stage-embedding.worker.js');
		createNewsOptionalWorker();
		expect(mocks.createWorker.mock.calls[0]?.[0]).toMatchObject({ queueName: 'news-optional-queue', concurrency: 1 });
	});
});
