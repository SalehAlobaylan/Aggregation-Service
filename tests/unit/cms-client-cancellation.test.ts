import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../src/config/index.js', () => ({ config: { cmsBaseUrl: 'https://cms.test/internal', cmsServiceToken: 'test-only' } }));
vi.mock('../../src/observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

afterEach(() => vi.unstubAllGlobals());

it('aborts an in-flight ingest HTTP request when its normalize job is cancelled', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    expect(init.signal).toBeDefined();
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    started();
  }));
  vi.stubGlobal('fetch', fetchMock);
  const { cmsClient } = await import('../../src/cms/client.js');
  const pending = cmsClient.createContentItem({ type: 'NEWS', source: 'REDDIT', status: 'PENDING', title: 'Test article', idempotency_key: 'test-only' }, 'test-request', controller.signal);
  const rejected = expect(pending).rejects.toThrow('normalize cancelled');
  await requestStarted;
  controller.abort(new Error('normalize cancelled'));
  await rejected;
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
