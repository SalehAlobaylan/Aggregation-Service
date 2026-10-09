import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { internalRoutes } from '../../src/server/routes/internal.js';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), getContentItem: vi.fn(), deleteObjects: vi.fn() }));
vi.mock('../../src/queues/index.js', () => ({ QUEUE_NAMES: {}, getQueue: vi.fn() }));
vi.mock('../../src/server/plugins/internal-auth.js', () => ({ verifyInternalServiceAuth: vi.fn(async () => undefined) }));
vi.mock('../../src/cms/client.js', () => ({ cmsClient: { authorizePodsResetObjectDeletion: mocks.authorize, getContentItem: mocks.getContentItem } }));
vi.mock('../../src/storage/client.js', () => ({
  deletePodsResetObjectsExact: mocks.deleteObjects,
  podsResetConfiguredTiers: () => ['primary'],
}));
vi.mock('../../src/services/quality.service.js', () => ({ resolveIngestProfile: vi.fn(), preflightCheck: vi.fn() }));
vi.mock('../../src/services/storage.service.js', () => ({ runSweepForTenant: vi.fn() }));
vi.mock('../../src/observability/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const payload = {
  run_id: '11111111-1111-4111-8111-111111111111', tenant_id: 'tenant-a',
  content_item_id: '22222222-2222-4222-8222-222222222222', manifest_hash: 'a'.repeat(64),
  fencing_token: '33333333-3333-4333-8333-333333333333', execution_token: '44444444-4444-4444-8444-444444444444',
  storage_bindings: [{ storage_tier: 'primary', bucket: 'test', endpoint_fingerprint: 'b'.repeat(64) }],
  objects: [{ storage_tier: 'primary', bucket: 'test', object_key: 'content/22222222-2222-4222-8222-222222222222/media.mp4', etag: 'etag', size_bytes: 64 }],
};
let server: ReturnType<typeof Fastify>;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue({ authorized: true });
  mocks.getContentItem.mockResolvedValue({ tenant_id: 'tenant-a', status: 'ARCHIVED', feed_visibility: 'hidden' });
  mocks.deleteObjects.mockResolvedValue({ storageBindings: payload.storage_bindings, deletedCount: 1, freedBytes: 64, objectsAbsent: true, deletedObjects: payload.objects, alreadyAbsentObjects: [] });
  server = Fastify();
  await server.register(internalRoutes);
});
afterEach(async () => { await server.close(); });

it('deletes the exact approved set only after CMS authorization and retired-content readback', async () => {
  const result = await server.inject({ method: 'POST', url: '/internal/pods-reset/delete-media-item', payload });
  expect(result.statusCode).toBe(200);
  expect(mocks.authorize).toHaveBeenCalledWith(payload);
  expect(mocks.deleteObjects).toHaveBeenCalledWith(payload.content_item_id, payload.objects, payload.storage_bindings);
  expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.getContentItem.mock.invocationCallOrder[0]);
  expect(mocks.getContentItem.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteObjects.mock.invocationCallOrder[0]);
  expect(result.json().data).toMatchObject({ objectsAbsent: true, deletedCount: 1, content_item_id: payload.content_item_id, fencing_token: payload.fencing_token });
});

it.each(['cms_authorization', 'cms_retirement_read', 'storage_deletion'])('identifies %s failures without returning raw details', async (phase) => {
  const error = Object.assign(new Error('private secret provider text'), { status: 503 });
  if (phase === 'cms_authorization') mocks.authorize.mockRejectedValue(error);
  if (phase === 'cms_retirement_read') mocks.getContentItem.mockRejectedValue(error);
  if (phase === 'storage_deletion') mocks.deleteObjects.mockRejectedValue(error);
  const result = await server.inject({ method: 'POST', url: '/internal/pods-reset/delete-media-item', payload });
  expect(result.statusCode).toBe(409);
  expect(result.json()).toMatchObject({ code: `pods_reset_${phase}_failed` });
  expect(result.body).not.toMatch(/private|secret/);
  if (phase !== 'storage_deletion') {
    expect(result.json()).toMatchObject({ cms_status: 503 });
    expect(mocks.deleteObjects).not.toHaveBeenCalled();
  }
});
