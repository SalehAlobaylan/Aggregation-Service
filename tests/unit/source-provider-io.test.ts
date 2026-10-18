import { describe, expect, it, vi } from 'vitest';
import { sourceProviderOperation, withSourceProviderIO } from '../../src/services/source-provider-io.js';

describe('source provider start authority', () => {
  it('does not manufacture provider-start proof for local validation rejection', async () => {
    const started = vi.fn();
    await expect(withSourceProviderIO(1, started, () => {}, async () => { throw new Error('local preflight'); })).rejects.toThrow('local preflight');
    expect(started).not.toHaveBeenCalled();
  });
  it('records each initiated transport before consuming its response and enforces the CMS cap', async () => {
    const order: string[] = [];
    const transport = vi.fn(async () => { order.push('transport'); return 'response'; });
    const started = vi.fn(async (ordinal: number) => { order.push(`receipt-${ordinal}`); });
    await withSourceProviderIO(1, started, () => {}, async () => {
      expect(await sourceProviderOperation(transport)).toBe('response');
      order.push('consume');
      await expect(sourceProviderOperation(transport)).rejects.toThrow('budget exhausted');
    });
    expect(order).toEqual(['transport', 'receipt-1', 'consume']);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not initiate transport after cancellation or ownership rejection', async () => {
    const transport = vi.fn();
    const started = vi.fn();
    await expect(withSourceProviderIO(1, started, () => { throw new Error('stale lease'); }, () => sourceProviderOperation(transport))).rejects.toThrow('stale lease');
    expect(transport).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });
  it('keeps concurrent source scopes independent', async () => {
    const first = vi.fn(async () => {}); const second = vi.fn(async () => {});
    await Promise.all([withSourceProviderIO(1, first, () => {}, () => sourceProviderOperation(async () => 1)), withSourceProviderIO(1, second, () => {}, () => sourceProviderOperation(async () => 2))]);
    expect(first).toHaveBeenCalledExactlyOnceWith(1); expect(second).toHaveBeenCalledExactlyOnceWith(1);
  });
  it('preserves uncertain transport evidence even if an adapter swallows a callback failure', async () => {
    const transport = vi.fn(async () => 'response');
    const started = vi.fn(async () => { throw new Error('Redis unavailable'); });
    await expect(withSourceProviderIO(2, started, () => {}, async () => {
      try { await sourceProviderOperation(transport); } catch { /* legacy adapter fallback */ }
      await expect(sourceProviderOperation(transport)).rejects.toThrow('durable start proof');
      return 'no_change';
    })).rejects.toThrow('durable start proof');
    expect(transport).toHaveBeenCalledTimes(1);
  });

});
