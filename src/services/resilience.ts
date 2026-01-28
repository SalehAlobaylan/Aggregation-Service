/**
 * Resilience utilities - Circuit breakers for all dependencies
 */
import { CircuitBreaker, CircuitBreakerConfig, CircuitState } from '../cms/circuit-breaker.js';
import { config } from '../config/index.js';
import { circuitState } from '../observability/metrics.js';
import { logger } from '../observability/logger.js';

// Circuit breaker instances for each dependency
const circuitBreakers: Map<string, CircuitBreaker> = new Map();

/**
 * Default circuit breaker config from environment
 */
function getDefaultConfig(): Omit<CircuitBreakerConfig, 'name'> {
    return {
        failureThreshold: config.cbFailureThreshold,
        resetTimeout: config.cbResetTimeoutMs,
        halfOpenRequests: config.cbHalfOpenRequests,
    };
}

/**
 * Get or create a circuit breaker for a dependency
 */
export function getCircuitBreaker(name: string): CircuitBreaker {
    let cb = circuitBreakers.get(name);

    if (!cb) {
        cb = new CircuitBreaker({
            name,
            ...getDefaultConfig(),
        });
        circuitBreakers.set(name, cb);
        logger.info(`Circuit breaker created: ${name}`, getDefaultConfig());
    }

    return cb;
}

// Pre-defined circuit breakers for known dependencies
export const cmsCircuitBreaker = getCircuitBreaker('cms');
export const storageCircuitBreaker = getCircuitBreaker('storage');
export const whisperCircuitBreaker = getCircuitBreaker('whisper');
export const youtubeCircuitBreaker = getCircuitBreaker('youtube');
export const redditCircuitBreaker = getCircuitBreaker('reddit');
export const twitterCircuitBreaker = getCircuitBreaker('twitter');

/**
 * Get all circuit breaker states for monitoring
 */
export function getAllCircuitStates(): Record<string, CircuitState> {
    const states: Record<string, CircuitState> = {};

    for (const [name, cb] of circuitBreakers) {
        states[name] = cb.getState();
    }

    return states;
}

/**
 * Check if any circuit breaker is open
 */
export function hasOpenCircuit(): boolean {
    for (const cb of circuitBreakers.values()) {
        if (cb.getState() === CircuitState.OPEN) {
            return true;
        }
    }
    return false;
}

/**
 * Reset all circuit breakers (for testing/recovery)
 */
export function resetAllCircuits(): void {
    for (const [name, cb] of circuitBreakers) {
        cb.reset();
        logger.info(`Circuit breaker reset: ${name}`);
    }
}

/**
 * Execute with circuit breaker protection
 */
export async function withCircuitBreaker<T>(
    name: string,
    fn: () => Promise<T>
): Promise<T> {
    const cb = getCircuitBreaker(name);
    return cb.execute(fn);
}

export { CircuitBreaker, CircuitState, CircuitBreakerConfig };
