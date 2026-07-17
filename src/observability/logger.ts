/**
 * Structured logger with correlation ID support
 */
import pino from 'pino';
import { config } from '../config/index.js';
import { redactLogData, safeFailureCode, safeFailureSummary } from './job-projection.js';

// Create base logger
const baseLogger = pino({
    level: config.logLevel,
    base: {
        service: 'aggregation-service',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level: (label) => ({ level: label }),
    },
});

// Logger interface with correlation ID support
export interface LogContext {
    jobId?: string;
    requestId?: string;
    sourceId?: string;
    contentItemId?: string;
    queue?: string;
    stage?: 'fetch' | 'normalize' | 'media' | 'transcript' | 'embedding';
}

class Logger {
    private logger: pino.Logger;

    constructor(context?: LogContext) {
        this.logger = context ? baseLogger.child(context) : baseLogger;
    }

    child(context: LogContext): Logger {
        const newLogger = new Logger();
        newLogger.logger = this.logger.child(context);
        return newLogger;
    }

    debug(message: string, data?: Record<string, unknown>): void {
        this.logger.debug(redactLogData(data || {}) as Record<string, unknown>, message);
    }

    info(message: string, data?: Record<string, unknown>): void {
        this.logger.info(redactLogData(data || {}) as Record<string, unknown>, message);
    }

    warn(message: string, data?: Record<string, unknown>): void {
        this.logger.warn(redactLogData(data || {}) as Record<string, unknown>, message);
    }

    error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
        const errorData = error instanceof Error
            ? { error: { code: safeFailureCode(error), message: safeFailureSummary(error) } }
            : error === undefined ? {} : { error: { code: safeFailureCode(error), message: safeFailureSummary(error) } };
        this.logger.error(redactLogData({ ...errorData, ...data }) as Record<string, unknown>, message);
    }
}

// Export singleton and factory
export const logger = new Logger();
export const createLogger = (context: LogContext) => new Logger(context);
