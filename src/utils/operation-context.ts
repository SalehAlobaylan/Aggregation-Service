export interface OperationContext {
    signal: AbortSignal;
    deadlineAt: number;
    requestId?: string;
}

/** Creates a bounded child context without replacing parent cancellation. */
export function createOperationContext(options: {
    parentSignal?: AbortSignal;
    timeoutMs: number;
    requestId?: string;
    now?: number;
}): OperationContext {
    const now = options.now ?? Date.now();
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signals = options.parentSignal ? [options.parentSignal, timeout] : [timeout];
    return {
        signal: signals.length === 1 ? timeout : AbortSignal.any(signals),
        deadlineAt: now + options.timeoutMs,
        requestId: options.requestId,
    };
}

/** Narrows, but never extends, an existing operation deadline. */
export function withOperationTimeout(
    parent: OperationContext,
    timeoutMs: number,
    now = Date.now(),
): OperationContext {
    const remainingMs = Math.max(0, parent.deadlineAt - now);
    const childTimeoutMs = Math.min(timeoutMs, remainingMs);
    const timeout = AbortSignal.timeout(childTimeoutMs);
    return {
        signal: AbortSignal.any([parent.signal, timeout]),
        deadlineAt: now + childTimeoutMs,
        requestId: parent.requestId,
    };
}
