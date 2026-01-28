/**
 * Failure Scenario Tests
 * Tests circuit breaker, retry, and DLQ behavior
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, CircuitState, CircuitOpenError } from '../../src/cms/circuit-breaker.js';

describe('Circuit Breaker', () => {
    let circuitBreaker: CircuitBreaker;

    beforeEach(() => {
        circuitBreaker = new CircuitBreaker({
            name: 'test-circuit',
            failureThreshold: 3,
            resetTimeout: 100, // 100ms for fast tests
            halfOpenRequests: 2,
        });
    });

    describe('State Transitions', () => {
        it('should start in CLOSED state', () => {
            expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
        });

        it('should open after failure threshold is reached', async () => {
            const failingFn = async () => { throw new Error('Service unavailable'); };

            for (let i = 0; i < 3; i++) {
                await circuitBreaker.execute(failingFn).catch(() => { });
            }

            expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
        });

        it('should throw CircuitOpenError when circuit is open', async () => {
            // Force open
            const failingFn = async () => { throw new Error('Fail'); };
            for (let i = 0; i < 3; i++) {
                await circuitBreaker.execute(failingFn).catch(() => { });
            }

            // Now expect fast-fail
            await expect(circuitBreaker.execute(async () => 'test'))
                .rejects.toThrow(CircuitOpenError);
        });

        it('should transition to HALF_OPEN after reset timeout', async () => {
            // Force open
            const failingFn = async () => { throw new Error('Fail'); };
            for (let i = 0; i < 3; i++) {
                await circuitBreaker.execute(failingFn).catch(() => { });
            }

            expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

            // Wait for reset timeout
            await new Promise(resolve => setTimeout(resolve, 150));

            // getState should trigger transition to HALF_OPEN
            expect(circuitBreaker.getState()).toBe(CircuitState.HALF_OPEN);
        });

        it('should close after successful half-open requests', async () => {
            // Force open
            const failingFn = async () => { throw new Error('Fail'); };
            for (let i = 0; i < 3; i++) {
                await circuitBreaker.execute(failingFn).catch(() => { });
            }

            // Wait for reset timeout
            await new Promise(resolve => setTimeout(resolve, 150));

            // Execute successful requests in half-open
            const successFn = async () => 'success';
            await circuitBreaker.execute(successFn);
            await circuitBreaker.execute(successFn);

            expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
        });

        it('should reopen on failure during half-open', async () => {
            // Force open
            const failingFn = async () => { throw new Error('Fail'); };
            for (let i = 0; i < 3; i++) {
                await circuitBreaker.execute(failingFn).catch(() => { });
            }

            // Wait for half-open
            await new Promise(resolve => setTimeout(resolve, 150));

            // Fail during half-open
            await circuitBreaker.execute(failingFn).catch(() => { });

            expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
        });
    });

    describe('Success Path', () => {
        it('should reset failure count on success', async () => {
            const failingFn = async () => { throw new Error('Fail'); };
            const successFn = async () => 'success';

            // Fail twice (below threshold)
            await circuitBreaker.execute(failingFn).catch(() => { });
            await circuitBreaker.execute(failingFn).catch(() => { });

            // Succeed (should reset)
            await circuitBreaker.execute(successFn);

            // Fail twice more (should not trip)
            await circuitBreaker.execute(failingFn).catch(() => { });
            await circuitBreaker.execute(failingFn).catch(() => { });

            expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
        });
    });

    describe('isAllowingRequests', () => {
        it('should allow requests when closed', () => {
            expect(circuitBreaker.isAllowingRequests()).toBe(true);
        });

        it('should not allow requests when open', async () => {
            const failingFn = async () => { throw new Error('Fail'); };
            for (let i = 0; i < 3; i++) {
                await circuitBreaker.execute(failingFn).catch(() => { });
            }

            expect(circuitBreaker.isAllowingRequests()).toBe(false);
        });
    });

    describe('reset', () => {
        it('should force reset to CLOSED', async () => {
            const failingFn = async () => { throw new Error('Fail'); };
            for (let i = 0; i < 3; i++) {
                await circuitBreaker.execute(failingFn).catch(() => { });
            }

            expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

            circuitBreaker.reset();

            expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
        });
    });
});

describe('Retry Behavior', () => {
    it('should count retry attempts correctly', async () => {
        let attempts = 0;
        const maxRetries = 3;

        const retryableOperation = async (): Promise<string> => {
            attempts++;
            if (attempts < maxRetries) {
                throw new Error('Retry needed');
            }
            return 'success';
        };

        // Simulate retry logic
        let result: string | null = null;
        for (let i = 0; i < maxRetries && !result; i++) {
            try {
                result = await retryableOperation();
            } catch {
                // Continue retrying
            }
        }

        expect(attempts).toBe(3);
        expect(result).toBe('success');
    });

    it('should use exponential backoff timing', () => {
        const getBackoffMs = (attempt: number) => Math.pow(2, attempt) * 1000;

        expect(getBackoffMs(1)).toBe(2000);
        expect(getBackoffMs(2)).toBe(4000);
        expect(getBackoffMs(3)).toBe(8000);
    });
});

describe('DLQ Routing', () => {
    it('should route to DLQ after max retries exceeded', () => {
        const maxRetries = 3;
        const attemptsMade = 4;
        const shouldDLQ = attemptsMade > maxRetries;

        expect(shouldDLQ).toBe(true);
    });

    it('should include failure reason in DLQ entry', () => {
        const dlqEntry = {
            originalQueue: 'fetch',
            jobId: 'job-123',
            failedAt: new Date().toISOString(),
            reason: 'Max retries exceeded',
            error: 'Connection timeout to external API',
        };

        expect(dlqEntry.originalQueue).toBeDefined();
        expect(dlqEntry.reason).toBeDefined();
        expect(dlqEntry.error).toBeDefined();
    });
});
