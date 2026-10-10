import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { internalRoutes } from '../../src/server/routes/internal.js';
const mocks = vi.hoisted(() => ({ sweep: vi.fn(), policies: vi.fn(), queue: vi.fn(), auth: vi.fn(async (_request, reply) => { if (_request.headers.authorization !== 'Bearer test') return reply.status(401).send({ message: 'Unauthorized' }); }) }));
vi.mock('../../src/queues/index.js', () => ({ QUEUE_NAMES: {}, getQueue: mocks.queue }));
vi.mock('../../src/server/plugins/internal-auth.js', () => ({ verifyInternalServiceAuth: mocks.auth }));
vi.mock('../../src/cms/client.js', () => ({ cmsClient: { listStoragePolicies: mocks.policies } }));
vi.mock('../../src/storage/client.js', () => ({}));
vi.mock('../../src/services/quality.service.js', () => ({ resolveIngestProfile: vi.fn(), preflightCheck: vi.fn() }));
vi.mock('../../src/services/storage.service.js', () => ({ runSweepForTenant: mocks.sweep }));
vi.mock('../../src/observability/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
it('retains authentication and rejects stale retention envelopes before any owner effects', async () => {
  const server = Fastify(); await server.register(internalRoutes);
  try {
    const denied = await server.inject({ method: 'POST', url: '/internal/retention/storage/sweep', payload: {} });
    expect(denied.statusCode).toBe(401);
    const retired = await server.inject({ method: 'POST', url: '/internal/retention/storage/sweep', headers: { authorization: 'Bearer test' }, payload: {
      tenant_id: 'default', owner: 'storage', action_class: 'storage.request_bounded_run',
      allowed_action_classes: ['storage.request_bounded_run'], max_bytes: 1024, max_items: 1, max_actions: 1,
      expires_at: new Date(Date.now() + 60_000).toISOString(), idempotency_key: 'old-approved-request',
      manifest_hash: 'a'.repeat(64), correlation_id: '11111111-1111-4111-8111-111111111111',
      owner_request_id: '22222222-2222-4222-8222-222222222222',
    } });
    expect(retired.statusCode).toBe(410); expect(retired.json().code).toBe('retention_capability_retired');
    expect(mocks.policies).not.toHaveBeenCalled(); expect(mocks.sweep).not.toHaveBeenCalled(); expect(mocks.queue).not.toHaveBeenCalled();
  } finally { await server.close(); }
});
