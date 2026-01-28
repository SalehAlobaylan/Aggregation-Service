/**
 * Circuit Breaker implementation
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failures exceeded threshold, requests fail fast
 * - HALF_OPEN: Testing if service is recovered
 */
import { logger } from '../observability/logger.js';
import { circuitState } from '../observability/metrics.js';

export enum CircuitState {
    CLOSED = 0,
    OPEN = 1,
    HALF_OPEN = 2,
}

export interface CircuitBreakerConfig {
    name: string;
    failureThreshold: number;      // Failures before opening
    resetTimeout: number;          // ms before transitioning to half-open
    halfOpenRequests: number;      // Test requests in half-open state
}

const DEFAULT_CONFIG: Omit<CircuitBreakerConfig, 'name'> = {
    failureThreshold: 5,
    resetTimeout: 30000,
    halfOpenRequests: 3,
};

export class CircuitBreaker {
    private state: CircuitState = CircuitState.CLOSED;
    private failureCount: number = 0;
    private successCount: number = 0;
    private lastFailureTime: number = 0;
    private halfOpenAttempts: number = 0;
    private readonly config: CircuitBreakerConfig;

    constructor(config: Partial<CircuitBreakerConfig> & { name: string }) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.updateMetrics();
    }

    /**
     * Execute a function with circuit breaker protection
     */
    async execute<T>(fn: () => Promise<T>): Promise<T> {
        if (this.state === CircuitState.OPEN) {
            // Check if reset timeout has passed
            if (Date.now() - this.lastFailureTime >= this.config.resetTimeout) {
                this.transitionTo(CircuitState.HALF_OPEN);
            } else {
                throw new CircuitOpenError(this.config.name);
            }
        }

        if (this.state === CircuitState.HALF_OPEN) {
            if (this.halfOpenAttempts >= this.config.halfOpenRequests) {
                // All half-open requests used, wait for results
                throw new CircuitOpenError(this.config.name);
            }
            this.halfOpenAttempts++;
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    /**
     * Record a successful call
     */
    private onSuccess(): void {
        if (this.state === CircuitState.HALF_OPEN) {
            this.successCount++;
            if (this.successCount >= this.config.halfOpenRequests) {
                this.transitionTo(CircuitState.CLOSED);
            }
        } else if (this.state === CircuitState.CLOSED) {
            // Reset failure count on success
            this.failureCount = 0;
        }
    }

    /**
     * Record a failed call
     */
    private onFailure(): void {
        this.failureCount++;
        this.lastFailureTime = Date.now();

        if (this.state === CircuitState.HALF_OPEN) {
            // Any failure in half-open returns to open
            this.transitionTo(CircuitState.OPEN);
        } else if (this.state === CircuitState.CLOSED) {
            if (this.failureCount >= this.config.failureThreshold) {
                this.transitionTo(CircuitState.OPEN);
            }
        }
    }

    /**
     * Transition to a new state
     */
    private transitionTo(newState: CircuitState): void {
        const oldState = this.state;
        this.state = newState;

        if (newState === CircuitState.CLOSED) {
            this.failureCount = 0;
            this.successCount = 0;
            this.halfOpenAttempts = 0;
        } else if (newState === CircuitState.HALF_OPEN) {
            this.successCount = 0;
            this.halfOpenAttempts = 0;
        }

        logger.info(`Circuit breaker ${this.config.name} transitioned`, {
            from: CircuitState[oldState],
            to: CircuitState[newState],
        });

        this.updateMetrics();
    }

    /**
     * Update Prometheus metrics
     */
    private updateMetrics(): void {
        circuitState.labels(this.config.name).set(this.state);
    }

    /**
     * Get current state
     */
    getState(): CircuitState {
        // Check if we should transition from OPEN to HALF_OPEN
        if (this.state === CircuitState.OPEN) {
            if (Date.now() - this.lastFailureTime >= this.config.resetTimeout) {
                this.transitionTo(CircuitState.HALF_OPEN);
            }
        }
        return this.state;
    }

    /**
     * Check if circuit is allowing requests
     */
    isAllowingRequests(): boolean {
        const state = this.getState();
        return state === CircuitState.CLOSED ||
            (state === CircuitState.HALF_OPEN && this.halfOpenAttempts < this.config.halfOpenRequests);
    }

    /**
     * Force reset the circuit breaker
     */
    reset(): void {
        this.transitionTo(CircuitState.CLOSED);
    }
}

/**
 * Error thrown when circuit is open
 */
export class CircuitOpenError extends Error {
    constructor(circuitName: string) {
        super(`Circuit breaker '${circuitName}' is open`);
        this.name = 'CircuitOpenError';
    }
}
