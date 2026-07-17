import { describe, expect, it } from 'vitest';
import { createOperationContext } from '../../src/utils/operation-context.js';
import { withOperationTimeout } from '../../src/utils/operation-context.js';

describe('operation context', () => {
    it('preserves parent cancellation while retaining an absolute deadline', () => {
        const parent = new AbortController();
        const context = createOperationContext({ parentSignal: parent.signal, timeoutMs: 1000, requestId: 'request-1', now: 50 });
        expect(context.deadlineAt).toBe(1050);
        expect(context.requestId).toBe('request-1');
        expect(context.signal.aborted).toBe(false);
        parent.abort(new Error('worker stopped'));
        expect(context.signal.aborted).toBe(true);
    });
});

it('never lets a child operation outlive its parent deadline', () => {
    const parent = createOperationContext({ timeoutMs: 1000, requestId: 'request-1', now: 10_000 });
    const child = withOperationTimeout(parent, 5000, 10_100);
    expect(child.deadlineAt).toBe(11_000);
    expect(child.requestId).toBe('request-1');
});
