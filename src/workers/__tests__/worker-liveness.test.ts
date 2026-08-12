import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mandatoryWorkersHealthy, registerWorkerLiveness, workerHeartbeatStaleMs, workerLivenessTestUtils } from '../worker-liveness.js';

class FakeWorker extends EventEmitter {
    name: string;
    running = true;
    paused = false;
    constructor(name: string) { super(); this.name = name; }
    isRunning(): boolean { return this.running; }
    isPaused(): boolean { return this.paused; }
}

test('worker liveness fails closed until every mandatory worker emitted a ready heartbeat', () => {
        workerLivenessTestUtils.reset();
        const first = new FakeWorker('first');
        const second = new FakeWorker('second');
        registerWorkerLiveness(first as never);
        registerWorkerLiveness(second as never);
        assert.equal(mandatoryWorkersHealthy(['first', 'second']), false);
        first.emit('ready');
        second.emit('ready');
        assert.equal(mandatoryWorkersHealthy(['first', 'second']), true);
        assert.equal(mandatoryWorkersHealthy(['first', 'second'], Date.now() + workerHeartbeatStaleMs + 1), false);
        first.emit('closed');
        second.emit('closed');
});
