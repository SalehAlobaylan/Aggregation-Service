import type { Worker } from 'bullmq';

export interface WorkerLivenessSnapshot {
    queueName: string;
    state: 'starting' | 'ready' | 'degraded' | 'closed';
    registeredAt: number;
    lastHeartbeatAt: number;
    lastActivityAt: number | null;
    failureCode: string | null;
}

const heartbeatEveryMs = 10_000;
export const workerHeartbeatStaleMs = 45_000;
const snapshots = new Map<string, WorkerLivenessSnapshot>();
const timers = new WeakMap<Worker, NodeJS.Timeout>();

export function registerWorkerLiveness(worker: Worker): void {
    const now = Date.now();
    snapshots.set(worker.name, {
        queueName: worker.name,
        state: 'starting',
        registeredAt: now,
        lastHeartbeatAt: now,
        lastActivityAt: null,
        failureCode: null,
    });
    const beat = (): void => {
        const current = snapshots.get(worker.name);
        if (!current) return;
        if (worker.isRunning() && !worker.isPaused()) {
            snapshots.set(worker.name, { ...current, state: 'ready', lastHeartbeatAt: Date.now(), failureCode: null });
        }
    };
    const activity = (): void => {
        const current = snapshots.get(worker.name);
        if (!current) return;
        const at = Date.now();
        snapshots.set(worker.name, { ...current, state: 'ready', lastHeartbeatAt: at, lastActivityAt: at, failureCode: null });
    };
    worker.on('ready', activity);
    worker.on('active', activity);
    worker.on('completed', activity);
    worker.on('failed', activity);
    worker.on('stalled', activity);
    worker.on('error', () => {
        const current = snapshots.get(worker.name);
        if (current) snapshots.set(worker.name, { ...current, state: 'degraded', failureCode: 'worker_error' });
    });
    worker.on('closed', () => {
        const current = snapshots.get(worker.name);
        if (current) snapshots.set(worker.name, { ...current, state: 'closed', failureCode: 'worker_closed' });
        const timer = timers.get(worker);
        if (timer) clearInterval(timer);
    });
    const timer = setInterval(beat, heartbeatEveryMs);
    timer.unref();
    timers.set(worker, timer);
}

export function getWorkerLiveness(now = Date.now()): Record<string, WorkerLivenessSnapshot & { fresh: boolean }> {
    return Object.fromEntries([...snapshots.entries()].map(([name, snapshot]) => [name, {
        ...snapshot,
        fresh: snapshot.state === 'ready' && now - snapshot.lastHeartbeatAt <= workerHeartbeatStaleMs,
    }]));
}

export function mandatoryWorkersHealthy(names: readonly string[], now = Date.now()): boolean {
    const current = getWorkerLiveness(now);
    return names.every((name) => current[name]?.fresh === true);
}

export const workerLivenessTestUtils = {
    reset(): void {
        snapshots.clear();
    },
};
