import { toDebugJSON } from './debug.js';
import type { MappedError } from './map.js';
import type { Clock, LoggerLike } from './ports.js';
import type { Redactor } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

export interface DedupeOptions {
  /** Window in which repeated identical client errors are logged once. Default 60000 ms. */
  windowMs?: number;
  /** Maximum distinct keys tracked. Default 1000 (oldest evicted first). */
  maxKeys?: number;
}

export interface ErrorLoggerOptions {
  logger?: LoggerLike;
  /** Level for 4xx errors. Default `info`. */
  clientErrorLevel?: LogLevel;
  /** Level for 5xx errors. Default `error`. */
  serverErrorLevel?: LogLevel;
  /** Deduplicate repeated identical 4xx errors. Default off. */
  dedupeClientErrors?: boolean | DedupeOptions;
  clock?: Clock;
  redactor: Redactor;
}

export interface ErrorLogContext {
  correlationId?: string | undefined;
  method?: string | undefined;
  path?: string | undefined;
}

export interface ErrorLogger {
  log(err: unknown, mapped: MappedError, context: ErrorLogContext): void;
}

const noop = (): void => {};
export const noopLogger: LoggerLike = { debug: noop, info: noop, warn: noop, error: noop };

/** Creates the error logger used by error handlers (LoggerLike port, pino convention). */
export function createErrorLogger(options: ErrorLoggerOptions): ErrorLogger {
  const logger = options.logger ?? noopLogger;
  const clientLevel = options.clientErrorLevel ?? 'info';
  const serverLevel = options.serverErrorLevel ?? 'error';
  const clock = options.clock ?? { now: () => Date.now() };
  const redactor = options.redactor;
  const dedupe =
    options.dedupeClientErrors === true
      ? {}
      : options.dedupeClientErrors === false || options.dedupeClientErrors === undefined
        ? undefined
        : options.dedupeClientErrors;
  const windowMs = dedupe?.windowMs ?? 60_000;
  const maxKeys = dedupe?.maxKeys ?? 1000;
  const seen = new Map<string, { until: number; suppressed: number }>();

  const emit = (level: LogLevel, obj: Record<string, unknown>, msg: string): void => {
    if (level === 'silent') return;
    logger[level](obj, msg);
  };

  return {
    log(err, mapped, context) {
      const base: Record<string, unknown> = {
        status: mapped.status,
        code: mapped.code,
        category: mapped.category,
        operational: mapped.operational,
      };
      if (context.correlationId !== undefined) base.correlationId = context.correlationId;
      if (context.method !== undefined) base.method = context.method;
      if (context.path !== undefined) base.path = redactor.string(context.path);

      if (mapped.status >= 500) {
        emit(
          serverLevel,
          { ...base, err: toDebugJSON(err, { redactor }) },
          redactor.string(mapped.internalMessage) || mapped.title,
        );
        return;
      }
      if (clientLevel === 'silent') return;
      if (dedupe) {
        const key = `${mapped.status}:${mapped.code}:${context.method ?? ''}:${context.path ?? ''}`;
        const now = clock.now();
        const entry = seen.get(key);
        if (entry && entry.until > now) {
          entry.suppressed++;
          return;
        }
        if (entry) {
          seen.delete(key);
          if (entry.suppressed > 0) base.suppressed = entry.suppressed;
        }
        if (seen.size >= maxKeys) {
          const oldest = seen.keys().next();
          if (!oldest.done) seen.delete(oldest.value);
        }
        seen.set(key, { until: now + windowMs, suppressed: 0 });
      }
      emit(
        clientLevel,
        { ...base, message: redactor.string(mapped.internalMessage) },
        mapped.title,
      );
    },
  };
}
