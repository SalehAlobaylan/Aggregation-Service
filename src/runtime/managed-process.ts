/**
 * One lifecycle owner for external media commands.  Each command gets its own
 * process group so aborting a BullMQ attempt cannot leave yt-dlp's ffmpeg (or
 * another descendant) running after its owner has exited.
 */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'child_process';
import { managedChildren, managedProcessTerminations } from '../observability/metrics.js';

export interface ManagedProcessOptions {
    label: string;
    args: string[];
    timeoutMs: number;
    signal?: AbortSignal;
    cwd?: string;
    onStdout?: (chunk: Buffer) => void;
    onStderr?: (chunk: Buffer) => void;
}

export interface ManagedProcessResult {
    code: number | null;
    signal: NodeJS.Signals | null;
}

const active = new Map<number, { label: string; process: ChildProcessWithoutNullStreams }>();

export function activeManagedProcesses(): Array<{ pid: number; label: string }> {
    return [...active.entries()].map(([pid, entry]) => ({ pid, label: entry.label }));
}

function abortError(label: string, reason: unknown): Error {
    return reason instanceof Error ? reason : new Error(`${label} aborted`);
}

function terminateTree(child: ChildProcessWithoutNullStreams, label: string, force = false): void {
    const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
    const pid = child.pid;
    if (!pid) return;
    try {
        // `detached` creates a POSIX process group. Negative PID targets every
        // descendant (not just yt-dlp's wrapper process).
        if (process.platform !== 'win32') process.kill(-pid, signal);
        else child.kill(signal);
        managedProcessTerminations.labels(label, force ? 'kill' : 'term').inc();
    } catch (error: unknown) {
        // ESRCH is success: the child/group already exited.
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error;
    }
}

export async function runManagedProcess(options: ManagedProcessOptions): Promise<ManagedProcessResult> {
    if (options.signal?.aborted) throw abortError(options.label, options.signal.reason);
    const spawnOptions: SpawnOptions = {
        cwd: options.cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
    };
    const child = spawn(options.label, options.args, spawnOptions) as ChildProcessWithoutNullStreams;
    if (!child.pid) throw new Error(`${options.label} did not return a process id`);
    active.set(child.pid, { label: options.label, process: child });
    managedChildren.labels(options.label).inc();

    let timeout: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let aborted = false;
    const stop = (reason: unknown) => {
        if (aborted) return;
        aborted = true;
        terminateTree(child, options.label);
        escalation = setTimeout(() => terminateTree(child, options.label, true), 5_000);
        escalation.unref();
        void reason;
    };
    const onAbort = () => stop(options.signal?.reason);

    try {
        return await new Promise<ManagedProcessResult>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => {
                if (aborted) {
                    reject(abortError(options.label, options.signal?.reason));
                    return;
                }
                resolve({ code, signal });
            });
            child.stdout.on('data', (chunk: Buffer) => options.onStdout?.(chunk));
            child.stderr.on('data', (chunk: Buffer) => options.onStderr?.(chunk));
            timeout = setTimeout(() => stop(new Error(`${options.label} timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
            timeout.unref();
            options.signal?.addEventListener('abort', onAbort, { once: true });
        });
    } finally {
        if (timeout) clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        options.signal?.removeEventListener('abort', onAbort);
        active.delete(child.pid);
        managedChildren.labels(options.label).dec();
    }
}

/** Terminate every child owned by this Aggregation role during shutdown. */
export async function terminateManagedProcesses(): Promise<void> {
    const children = [...active.values()];
    for (const entry of children) terminateTree(entry.process, entry.label);
    await new Promise(resolve => setTimeout(resolve, 250));
    for (const entry of children) terminateTree(entry.process, entry.label, true);
}
