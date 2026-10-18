import { AsyncLocalStorage } from 'node:async_hooks';

interface ProviderIOContext {
  count: number;
  cap: number;
  started: (ordinal: number) => Promise<void>;
  assertCurrent: () => void;
  evidenceFailure?: ProviderStartProofError;
}
export class ProviderStartProofError extends Error {
  constructor() { super("Provider transport started but its durable start proof could not be retained"); }
}

const providerIO = new AsyncLocalStorage<ProviderIOContext>();

export function withSourceProviderIO<T>(cap: number, started: (ordinal: number) => Promise<void>, assertCurrent: () => void, operation: () => Promise<T>): Promise<T> {
  const context: ProviderIOContext = { count: 0, cap, started, assertCurrent };
  return providerIO.run(context, async () => {
    const result = await operation();
    if (context.evidenceFailure) throw context.evidenceFailure;
    return result;
  });
}

/** Invoke after local validation/rate limiting. Receipt retention follows
 * transport initiation; an interrupted retention remains effect uncertainty. */
export async function sourceProviderOperation<T>(operation: () => Promise<T>): Promise<T> {
  const context = providerIO.getStore();
  if (!context) return operation();
  if (context.evidenceFailure) throw context.evidenceFailure;
  context.assertCurrent();
  if (context.count >= context.cap) throw new Error('CMS source provider-call budget exhausted');
  const pending = operation();
  void pending.catch(() => undefined);
  const ordinal = ++context.count;
  try { await context.started(ordinal); }
  catch { context.evidenceFailure = new ProviderStartProofError(); throw context.evidenceFailure; }
  return pending;
}

export function sourceProviderFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> {
  return sourceProviderOperation(() => globalThis.fetch(input, init));
}
