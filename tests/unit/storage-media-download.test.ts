import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

const getObjectStream = vi.hoisted(() => vi.fn());
vi.mock('../../src/storage/client.js', () => ({ getObjectStream }));
vi.mock('../../src/media/downloader.js', () => ({ MAX_MEDIA_DOWNLOAD_BYTES: 8 }));
import { downloadStorageObject } from '../../src/media/storage-downloader.js';

describe('verified storage media transfer', () => {
  let folder: string;
  beforeEach(async () => {
    getObjectStream.mockReset();
    folder = await mkdtemp(join(tmpdir(), 'wahb-storage-download-'));
  });
  afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

  it('reads the exact key and cold-tier binding without using its public URL', async () => {
    getObjectStream.mockResolvedValue({ body: Readable.from([Buffer.from('audio')]), size: 5, contentType: 'audio/mp4' });
    const result = await downloadStorageObject('content/source.m4a', 'cold', 'episode', 'm4a', undefined, folder);
    expect(getObjectStream).toHaveBeenCalledWith('content/source.m4a', 'cold', expect.any(AbortSignal));
    expect(await readFile(result.filePath, 'utf8')).toBe('audio');
  });

  it.each([
    { size: 9, data: 'audio', type: 'audio/mp4', error: /size cap/ },
    { size: 0, data: '123456789', type: 'audio/mp4', error: /size cap during stream/ },
    { size: 8, data: 'short', type: 'audio/mp4', error: /incomplete/ },
    { size: 0, data: '', type: 'audio/mp4', error: /empty/ },
    { size: 5, data: '<html', type: 'text/html', error: /non-media/ },
  ])('cleans up a rejected transfer ($size, $type, $data)', async ({ size, data, type, error }) => {
    const body = Readable.from([Buffer.from(data)]);
    getObjectStream.mockResolvedValue({ body, size, contentType: type });
    await expect(downloadStorageObject('source', 'primary', 'episode', 'mp4', undefined, folder)).rejects.toThrow(error);
    expect(body.destroyed).toBe(true);
    expect(await readdir(folder)).toEqual([]);
  });

  it('aborts an in-flight stream when the owner lease is lost', async () => {
    const owner = new AbortController();
    const body = new PassThrough();
    getObjectStream.mockImplementation(async (_key, _tier, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      setImmediate(() => { body.write('a'); owner.abort(new Error('lease lost')); });
      return { body, size: 0 };
    });
    await expect(downloadStorageObject('source', 'primary', 'episode', 'mp4', owner.signal, folder)).rejects.toThrow(/abort/i);
    expect(body.destroyed).toBe(true);
    expect(getObjectStream.mock.calls[0]![2].aborted).toBe(true);
    expect(await readdir(folder)).toEqual([]);
  });

  it('bounds storage inactivity and cancels the S3 request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = new PassThrough();
    getObjectStream.mockResolvedValue({ body, size: 0 });
    try {
      const transfer = downloadStorageObject('source', 'primary', 'episode', 'mp4', undefined, folder);
      const rejection = expect(transfer).rejects.toThrow(/abort/i);
      // mkdir is real I/O; allow the S3 read to begin before advancing time.
      while (!getObjectStream.mock.calls.length) await new Promise(resolve => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(body.destroyed).toBe(true);
      expect(getObjectStream.mock.calls[0]![2].aborted).toBe(true);
      expect(await readdir(folder)).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
