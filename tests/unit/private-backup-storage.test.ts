import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  config: { storageEndpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`, storageBucket: 'media', backupStorageBucket: 'backups' as string | undefined, coldStorageBucket: 'cold', storagePublicUrl: 'https://media.example.com', storageRegion: 'auto', storageAccessKey: 'test', storageSecretKey: 'test' },
}));
vi.mock('../../src/config/index.js', () => ({ config: mocks.config }));
vi.mock('../../src/storage/op-counter.js', () => ({ attachOpCounter: vi.fn() }));
vi.mock('@aws-sdk/client-s3', async importOriginal => ({
  ...await importOriginal<typeof import('@aws-sdk/client-s3')>(),
  S3Client: class { send = mocks.send; },
}));
import { deleteObject, getPublicUrl, objectExists, readObjectBuffer, readObjectDigest, recoveryArtifactEncryptionVerified, uploadEncryptedMigrationArtifact, uploadEncryptedRecoveryArtifact } from '../../src/storage/client.js';

describe('private backup storage boundary', () => {
  beforeEach(() => {
    mocks.send.mockReset();
    mocks.config.backupStorageBucket = 'backups';
    mocks.config.storageEndpoint = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`;
  });

  it('routes both backup families and their read/delete operations to the private bucket', async () => {
    mocks.send.mockImplementation(async command => command.constructor.name === 'GetObjectCommand' ? { Body: Readable.from([Buffer.from('backup')]) } : {});
    await uploadEncryptedRecoveryArtifact('recovery', Buffer.from('backup'));
    await uploadEncryptedMigrationArtifact('dump', Readable.from(['backup']), 6, 'application/octet-stream');
    expect(await readObjectBuffer('recovery', 10, 'backup')).toEqual(Buffer.from('backup'));
    expect((await readObjectDigest('dump', 10, 'backup')).bytes).toBe(6);
    expect(await objectExists('dump', 'backup')).toBe(true);
    await deleteObject('dump', 'backup');
    expect(mocks.send.mock.calls.every(([command]) => command.input.Bucket === 'backups')).toBe(true);
    const puts = mocks.send.mock.calls.filter(([command]) => command.constructor.name === 'PutObjectCommand');
    expect(puts).toHaveLength(2);
    for (const [command] of puts) expect(command.input).toMatchObject({ ServerSideEncryption: 'AES256', IfNoneMatch: '*' });
  });

  it.each([undefined, 'media', 'cold'])('fails before any storage call when backup bucket is %s', async bucket => {
    mocks.config.backupStorageBucket = bucket;
    await expect(uploadEncryptedRecoveryArtifact('key', Buffer.from('backup'))).rejects.toThrow('separate private backup bucket');
    await expect(readObjectBuffer('key', 10, 'backup')).rejects.toThrow('separate private backup bucket');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('keeps ordinary media in its existing bucket and refuses backup public URLs', async () => {
    mocks.send.mockResolvedValue({});
    await objectExists('media');
    expect(mocks.send.mock.calls[0][0].input.Bucket).toBe('media');
    expect(getPublicUrl('media')).toBe('https://media.example.com/media');
    expect(() => getPublicUrl('key', 'backup' as 'primary')).toThrow('no public URL');
  });

  it('requires positive bucket encryption proof for R2 when object HEAD omits encryption', async () => {
    mocks.send.mockResolvedValueOnce({}).mockResolvedValueOnce({ ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } });
    expect(await recoveryArtifactEncryptionVerified('key')).toBe(true);
    expect(mocks.send.mock.calls.map(([command]) => command.constructor.name)).toEqual(['HeadObjectCommand', 'GetBucketEncryptionCommand']);
    expect(mocks.send.mock.calls.every(([command]) => command.input.Bucket === 'backups')).toBe(true);
  });

  it.each([{}, { ServerSideEncryptionConfiguration: { Rules: [] } }])('rejects missing provider encryption proof', async proof => {
    mocks.send.mockResolvedValueOnce({}).mockResolvedValueOnce(proof);
    expect(await recoveryArtifactEncryptionVerified('key')).toBe(false);
  });

  it('fails closed when the provider encryption check fails', async () => {
    mocks.send.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(recoveryArtifactEncryptionVerified('key')).rejects.toThrow('AccessDenied');
  });

  it.each(['https://other.example.com', `http://${'a'.repeat(32)}.r2.cloudflarestorage.com`])('does not infer R2 encryption for %s', async endpoint => {
    mocks.config.storageEndpoint = endpoint;
    mocks.send.mockResolvedValue({});
    expect(await recoveryArtifactEncryptionVerified('key')).toBe(false);
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it.each(['AES256', 'aws:kms'])('accepts explicit object encryption proof %s', async algorithm => {
    mocks.send.mockResolvedValue({ ServerSideEncryption: algorithm });
    expect(await recoveryArtifactEncryptionVerified('key')).toBe(true);
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});
