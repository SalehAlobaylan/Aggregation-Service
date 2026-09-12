import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fetchMedia = vi.hoisted(() => vi.fn());
vi.mock('../../src/utils/safe-fetch.js', () => ({ safeFetchResponse: fetchMedia, assertPublicUrl: vi.fn() }));
import { downloadHttp } from '../../src/media/downloader.js';
import { config } from '../../src/config/index.js';

describe('HTTP media transfer lifetime', () => {
  it('uses the media workload deadline, preserves caller cancellation and closes the response', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'wahb-download-test-'));
    const close = vi.fn(async () => {});
    fetchMedia.mockResolvedValue({ response: new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }), close });
    const owner = new AbortController();
    try {
      const result = await downloadHttp('https://example.com/source.mp4', 'fixture', 'mp4', owner.signal, folder);
      const options = fetchMedia.mock.calls.at(-1)![1];
      expect(options.timeoutMs).toBe(config.mediaJobTimeoutMs);
      expect(options.timeoutMs).toBeGreaterThan(30_000);
      expect(await readFile(result.filePath)).toEqual(Buffer.from([1, 2, 3]));
      expect(close).toHaveBeenCalledOnce();
      owner.abort(new Error('lease lost'));
      expect(options.signal.aborted).toBe(true);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
