import { getRequestContext } from './context.js';
import { configError } from './errors.js';
import type { Counter, Histogram, LabelValues, MetricsRegistry } from './metrics.js';
import type { LoggerLike } from './ports.js';

export type CaptureLevel = 'warn' | 'error' | 'fatal';

export interface CaptureErrorContext {
  /** Where the error surfaced: `http`, `job`, `process`, ... Used as a metric label. */
  source?: string;
  /** Log level. Default `warn` for errors with status < 500, otherwise `error`. */
  level?: CaptureLevel;
  [key: string]: unknown;
}

export type CaptureError = (error: unknown, context?: CaptureErrorContext) => void;

export interface ErrorCaptureOptions {
  logger?: LoggerLike & { fatal?: LoggerLike['error'] };
  registry?: MetricsRegistry;
  /** Counter name (without registry prefix). Default `errors_total`. */
  metricName?: string;
  /** Called after logging, for example to forward to an error tracker. Failures are ignored. */
  onError?: (error: unknown, context: CaptureErrorContext) => void;
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_SOURCE = /^[a-z0-9_.-]{1,32}$/;

function typeOf(error: unknown): string {
  if (error instanceof Error) {
    if (typeof error.name === 'string' && error.name.length > 0 && error.name.length <= 64)
      return error.name;
    return 'Error';
  }
  return 'NonError';
}

/**
 * Creates `captureError(err, context)`: logs the error with its context (request ID and trace
 * IDs are added by the logger) and increments `errors_total{type, code, source}`. The same
 * Error object is only counted once, so middleware and handlers can both call it safely.
 */
export function createErrorCapture(options: ErrorCaptureOptions = {}): CaptureError {
  const counter: Counter | undefined = options.registry?.counter({
    name: options.metricName ?? 'errors_total',
    help: 'Errors captured by type, code and source.',
    labelNames: ['type', 'code', 'source'],
  });
  const captured = new WeakSet<object>();
  return (error, context = {}) => {
    if (typeof error === 'object' && error !== null) {
      if (captured.has(error)) return;
      captured.add(error);
    }
    const err =
      error instanceof Error
        ? error
        : new Error(typeof error === 'string' ? error : 'Non-error value thrown');
    const status = (error as { status?: unknown } | null)?.status;
    const rawCode = (error as { code?: unknown } | null)?.code;
    const code = typeof rawCode === 'string' && SAFE_CODE.test(rawCode) ? rawCode : '';
    const source =
      typeof context.source === 'string' && SAFE_SOURCE.test(context.source)
        ? context.source
        : 'app';
    const level: CaptureLevel =
      context.level ?? (typeof status === 'number' && status < 500 ? 'warn' : 'error');
    counter?.inc({ type: typeOf(error), code, source });
    const { level: _level, ...fields } = context;
    const logger = options.logger;
    if (logger) {
      const record: Record<string, unknown> = { err, ...fields, source };
      if (!(error instanceof Error)) record.thrown = error;
      const message = err.message || 'error captured';
      if (level === 'fatal' && typeof logger.fatal === 'function') logger.fatal(record, message);
      else if (level === 'warn') logger.warn(record, message);
      else logger.error(record, message);
    }
    if (options.onError) {
      try {
        options.onError(error, { ...context, source, requestId: getRequestContext()?.requestId });
      } catch {
        // Forwarding failures must never break the request that raised the error.
      }
    }
  };
}

export interface ProcessErrorHandlerOptions {
  /** Exit with code 1 after an uncaught exception. Default true (Node's own behaviour). */
  exitOnUncaughtException?: boolean;
  /** Exit with code 1 after an unhandled rejection. Default true (Node's default since v15). */
  exitOnUnhandledRejection?: boolean;
  /** Flushes buffered logs before exiting. */
  flush?: () => void;
}

/**
 * Captures `uncaughtException` and `unhandledRejection` at fatal level, flushes logs and
 * (by default) exits with code 1, preserving Node's crash semantics. Returns a dispose function.
 */
export function installProcessErrorHandlers(
  captureError: CaptureError,
  options: ProcessErrorHandlerOptions = {},
): () => void {
  const exitUncaught = options.exitOnUncaughtException ?? true;
  const exitRejection = options.exitOnUnhandledRejection ?? true;
  const onUncaught = (error: unknown): void => {
    captureError(error, { source: 'process', level: 'fatal', event: 'uncaughtException' });
    options.flush?.();
    if (exitUncaught) process.exit(1);
  };
  const onRejection = (reason: unknown): void => {
    captureError(reason, {
      source: 'process',
      level: exitRejection ? 'fatal' : 'error',
      event: 'unhandledRejection',
    });
    options.flush?.();
    if (exitRejection) process.exit(1);
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
  };
}

export interface Timer {
  elapsedMs(): number;
  elapsedSeconds(): number;
}

/** Starts a monotonic high-resolution timer. */
export function startTimer(): Timer {
  const start = process.hrtime.bigint();
  const ns = (): number => Number(process.hrtime.bigint() - start);
  return { elapsedMs: () => ns() / 1e6, elapsedSeconds: () => ns() / 1e9 };
}

export interface PerformanceOptions {
  registry?: MetricsRegistry;
  /** Histogram name (without prefix). Default `operation_duration_seconds`. */
  metricName?: string;
  buckets?: readonly number[];
  /** Extra label names accepted by timed() and startTimer() labels. */
  labelNames?: readonly string[];
  logger?: LoggerLike;
  /** Log a warning for operations slower than this. Default: disabled. */
  slowThresholdMs?: number;
}

export interface OperationTimer {
  /** Records the duration with outcome `success` (default) or `error`; returns milliseconds. */
  end(outcome?: 'success' | 'error'): number;
}

export interface PerformanceInstrumentation {
  /**
   * Runs fn and records its duration as `operation_duration_seconds{operation, outcome}`.
   * Works for sync functions and functions returning promises; errors are rethrown.
   */
  timed<T>(name: string, fn: () => T, labels?: LabelValues): T;
  /** Starts a named operation timer. */
  startTimer(name: string, labels?: LabelValues): OperationTimer;
}

const OPERATION_NAME = /^[A-Za-z0-9_.:/-]{1,100}$/;

export function createPerformance(options: PerformanceOptions = {}): PerformanceInstrumentation {
  const slow = options.slowThresholdMs;
  if (slow !== undefined && (!Number.isFinite(slow) || slow < 0)) {
    throw configError('slowThresholdMs', 'must be a non-negative number');
  }
  const histogram: Histogram | undefined = options.registry?.histogram({
    name: options.metricName ?? 'operation_duration_seconds',
    help: 'Duration of timed operations in seconds.',
    labelNames: ['operation', 'outcome', ...(options.labelNames ?? [])],
    ...(options.buckets ? { buckets: options.buckets } : {}),
  });

  const begin = (name: string, labels: LabelValues | undefined): OperationTimer => {
    if (typeof name !== 'string' || !OPERATION_NAME.test(name)) {
      throw configError('name', 'operation names must match [A-Za-z0-9_.:/-]{1,100}');
    }
    const timer = startTimer();
    let done = false;
    return {
      end(outcome = 'success') {
        const ms = timer.elapsedMs();
        if (done) return ms;
        done = true;
        histogram?.observe({ ...labels, operation: name, outcome }, ms / 1000);
        if (slow !== undefined && ms >= slow) {
          options.logger?.warn(
            { operation: name, durationMs: Math.round(ms * 1000) / 1000, outcome },
            'slow operation',
          );
        }
        return ms;
      },
    };
  };

  return {
    startTimer: (name, labels) => begin(name, labels),
    timed<T>(name: string, fn: () => T, labels?: LabelValues): T {
      const t = begin(name, labels);
      let result: T;
      try {
        result = fn();
      } catch (error) {
        t.end('error');
        throw error;
      }
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        return (result as unknown as PromiseLike<unknown>).then(
          (value) => {
            t.end('success');
            return value;
          },
          (error: unknown) => {
            t.end('error');
            throw error;
          },
        ) as unknown as T;
      }
      t.end('success');
      return result;
    },
  };
}
