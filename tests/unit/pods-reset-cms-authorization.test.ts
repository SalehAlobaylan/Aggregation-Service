import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/config/index.js', () => ({ config: { cmsBaseUrl: 'https://cms.test/internal', cmsServiceToken: 'test-only' } }));
vi.mock('../../src/observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/observability/metrics.js', () => ({ circuitState: { labels: () => ({ set: vi.fn() }) } }));

const request = {
  run_id: '11111111-1111-4111-8111-111111111111', tenant_id: 'tenant-a',
  content_item_id: '22222222-2222-4222-8222-222222222222', manifest_hash: 'a'.repeat(64),
  fencing_token: '33333333-3333-4333-8333-333333333333', execution_token: '44444444-4444-4444-8444-444444444444',
  storage_bindings: [{ storage_tier: 'primary' as const, bucket: 'test', endpoint_fingerprint: 'b'.repeat(64) }], objects: [],
};

beforeEach(() => vi.resetModules());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('obtains real CMS authorization while unrelated ingestion has opened the shared circuit', async () => {
  const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
  vi.stubGlobal('fetch', fetchMock);
  const { cmsClient } = await import('../../src/cms/client.js');
  for (let index = 0; index < 5; index++) await expect(cmsClient.claimContentStage('pods')).rejects.toThrow('fetch failed');
  expect(cmsClient.isAvailable()).toBe(false);
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { authorized: true } })));
  await expect(cmsClient.authorizePodsResetObjectDeletion(request)).resolves.toEqual({ authorized: true });
  expect(fetchMock).toHaveBeenCalledTimes(6);
  expect(fetchMock.mock.calls[5]).toEqual([
    'https://cms.test/internal/pods-reset/authorize-object-deletion',
    expect.objectContaining({ method: 'POST', body: JSON.stringify(request), headers: expect.objectContaining({ Authorization: 'Bearer test-only' }) }),
  ]);
  // Reset authorization does not reopen ingestion or change its availability.
  expect(cmsClient.isAvailable()).toBe(false);
  await expect(cmsClient.claimContentStage('pods')).rejects.toThrow("Circuit breaker 'cms' is open");
  expect(fetchMock).toHaveBeenCalledTimes(6);
});

it('allows a CMS authorization response beyond the ordinary ten-second deadline', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('authorization deadline')), ms);
    return controller.signal;
  });
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    setTimeout(() => resolve(new Response(JSON.stringify({ data: { authorized: true } }))), 11_000);
  })));
  const { cmsClient } = await import('../../src/cms/client.js');
  const result = expect(cmsClient.authorizePodsResetObjectDeletion(request)).resolves.toEqual({ authorized: true });
  await vi.advanceTimersByTimeAsync(11_000);
  await result;
});

it.each([401, 409, 503])('preserves a real CMS refusal (%s) without automatically retrying authorization', async (status) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"private upstream detail"}', { status }));
  vi.stubGlobal('fetch', fetchMock);
  const { cmsClient } = await import('../../src/cms/client.js');
  await expect(cmsClient.authorizePodsResetObjectDeletion(request)).rejects.toThrow('status ' + status);
  expect(fetchMock).toHaveBeenCalledOnce();
});
