import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exists: vi.fn(), read: vi.fn(), digest: vi.fn(), encrypted: vi.fn(), put: vi.fn(), streamPut: vi.fn(), remove: vi.fn() }));
vi.mock('../../src/queues/index.js', () => ({ QUEUE_NAMES: {}, getQueue: vi.fn() }));
vi.mock('../../src/server/plugins/internal-auth.js', () => ({ verifyInternalServiceAuth: async (request, reply) => { if (request.headers.authorization !== 'Bearer test') return reply.status(401).send({ message: 'Unauthorized' }); } }));
vi.mock('../../src/cms/client.js', () => ({ cmsClient: {} }));
vi.mock('../../src/storage/client.js', () => ({ objectExists: mocks.exists, readObjectBuffer: mocks.read, readObjectDigest: mocks.digest, recoveryArtifactEncryptionVerified: mocks.encrypted, uploadEncryptedRecoveryArtifact: mocks.put, uploadEncryptedMigrationArtifact: mocks.streamPut, deleteObject: mocks.remove }));
vi.mock('../../src/services/quality.service.js', () => ({ resolveIngestProfile: vi.fn(), preflightCheck: vi.fn() }));
vi.mock('../../src/observability/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { internalRoutes } from '../../src/server/routes/internal.js';
const body = Buffer.from('non-content backup fixture');
const checksum = createHash('sha256').update(body).digest('hex');
const key = `system/recovery/default/11111111-1111-4111-8111-111111111111/${checksum}.json.gz`;

describe('private backup native routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.exists.mockResolvedValue(false);
    mocks.read.mockResolvedValue(body);
    mocks.digest.mockResolvedValue({ bytes: body.length, sha256: checksum });
    mocks.encrypted.mockResolvedValue(true);
    mocks.streamPut.mockImplementation(async (_key, stream) => { for await (const _chunk of stream) { /* Consume the upload exactly as the SDK does. */ } });
  });

  async function recovery(existing = false) {
    mocks.exists.mockResolvedValue(existing);
    const server = Fastify(); await server.register(internalRoutes);
    try { return await server.inject({ method: 'POST', url: '/internal/recovery-artifacts', headers: { authorization: 'Bearer test' }, payload: { key, sha256: checksum, payload_base64: body.toString('base64') } }); }
    finally { await server.close(); }
  }

  it('requires machine authentication before backup effects', async () => {
    const server = Fastify(); await server.register(internalRoutes);
    try { expect((await server.inject({ method: 'POST', url: '/internal/recovery-artifacts', payload: {} })).statusCode).toBe(401); }
    finally { await server.close(); }
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('reads back a new recovery backup in the private bucket', async () => {
    expect((await recovery()).statusCode).toBe(200);
    expect(mocks.exists).toHaveBeenCalledWith(key, 'backup');
    expect(mocks.read).toHaveBeenCalledWith(key, 32 * 1024 * 1024, 'backup');
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each(['encryption', 'readback'])('removes only a newly uploaded backup after %s failure', async failure => {
    if (failure === 'encryption') mocks.encrypted.mockResolvedValue(false);
    else mocks.read.mockResolvedValue(Buffer.from('wrong checksum'));
    expect((await recovery()).statusCode).toBe(failure === 'encryption' ? 409 : 502);
    expect(mocks.remove).toHaveBeenCalledWith(key, 'backup');
  });

  it('preserves an existing backup when encryption verification fails', async () => {
    mocks.encrypted.mockResolvedValue(false);
    expect((await recovery(true)).statusCode).toBe(409);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('does not delete a competing backup when conditional creation fails', async () => {
    mocks.put.mockRejectedValue(new Error('PreconditionFailed'));
    expect((await recovery()).statusCode).toBe(502);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each([true, false])('streams and verifies migration backups; encryption proof=%s', async encrypted => {
    mocks.encrypted.mockResolvedValue(encrypted);
    const server = Fastify(); await server.register(internalRoutes);
    try {
      const response = await server.inject({ method: 'POST', url: '/internal/database-migration-artifacts', headers: { authorization: 'Bearer test', 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'x-migration-program-id': '22222222-2222-4222-8222-222222222222', 'x-migration-unit-id': '33333333-3333-4333-8333-333333333333', 'x-content-sha256': checksum, 'x-artifact-kind': 'dump' }, payload: body });
      expect(response.statusCode).toBe(encrypted ? 200 : 502);
      expect(mocks.digest).toHaveBeenCalledWith(expect.stringContaining('system/database-migrations/'), 20 * 1024 ** 3, 'backup');
      if (encrypted) expect(mocks.remove).not.toHaveBeenCalled();
      else expect(mocks.remove).toHaveBeenCalledWith(expect.any(String), 'backup');
    } finally { await server.close(); }
  });
});
