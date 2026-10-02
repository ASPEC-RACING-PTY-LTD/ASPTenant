import { toDebugJSON } from './debug.js';
import type { LoggerLike } from './ports.js';
import { createRedactor, type RedactOptions } from './redact.js';

/** The subset of `process` used by the process handlers (injectable for tests). */
export interface ProcessLike {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  off(event: 'uncaughtException', listener: (error: Error) => void): unknown;
  exit(code?: number): unknown;
}

export type FatalEvent = 'uncaughtException' | 'unhandledRejection';

export interface ProcessHandlerOptions {
  logger?: LoggerLike;
  /** Graceful shutdown hook (close servers, flush logs). Awaited up to `timeoutMs`. */
  onFatal?: (error: unknown, event: FatalEvent) => void | Promise<void>;
  /** Exit code after a fatal error. Default 1. */
  exitCode?: number;
  /** Maximum time for `onFatal` before exiting anyway. Default 10000 ms. */
  timeoutMs?: number;
  /**
   * `fatal` (default) treats unhandled rejections like uncaught exceptions (Node's default
   * behaviour); `log` only logs them.
   */
  unhandledRejection?: 'fatal' | 'log';
  /** Exit the process after a fatal error. Default true. */
  exit?: boolean;
  redact?: RedactOptions;
  /** Target process (tests pass an EventEmitter). Default the global `process`. */
  process?: ProcessLike;
}

/**
 * Installs `unhandledRejection` and `uncaughtException` handlers that log the error with full
 * (redacted) debug information, run the graceful shutdown hook with a timeout, then exit.
 * Returns a function that removes the handlers.
 */
export function installProcessHandlers(options: ProcessHandlerOptions = {}): () => void {
  const target: ProcessLike = options.process ?? process;
  const exitCode = options.exitCode ?? 1;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new TypeError('installProcessHandlers exitCode must be an integer from 0 to 255');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('installProcessHandlers timeoutMs must be a non-negative number');
  }
  const redactor = createRedactor(options.redact);
  const logger = options.logger;
  let shuttingDown = false;

  const log = (level: 'error' | 'warn', err: unknown, event: FatalEvent, fatal: boolean): void => {
    const obj = { err: toDebugJSON(err, { redactor }), event, fatal };
    const msg = fatal ? `Fatal ${event}, shutting down` : `Unhandled ${event}`;
    try {
      if (logger) logger[level](obj, msg);
      else console.error(msg, JSON.stringify(obj));
    } catch {
      // Logging must not prevent shutdown.
    }
  };

  const fatal = (err: unknown, event: FatalEvent): void => {
    if (shuttingDown) {
      log('error', err, event, true);
      return;
    }
    shuttingDown = true;
    log('error', err, event, true);
    const finish = (): void => {
      if (options.exit !== false) target.exit(exitCode);
    };
    if (!options.onFatal) {
      finish();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      // Keeps the event loop alive so a hanging hook still ends in exit(exitCode).
      timer = setTimeout(resolve, timeoutMs);
    });
    const hook = (async () => options.onFatal?.(err, event))().catch((hookError: unknown) => {
      log('error', hookError, event, true);
    });
    void Promise.race([hook, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
      finish();
    });
  };

  const onRejection = (reason: unknown): void => {
    if (options.unhandledRejection === 'log') log('error', reason, 'unhandledRejection', false);
    else fatal(reason, 'unhandledRejection');
  };
  const onException = (error: Error): void => fatal(error, 'uncaughtException');

  target.on('unhandledRejection', onRejection);
  target.on('uncaughtException', onException);
  return () => {
    target.off('unhandledRejection', onRejection);
    target.off('uncaughtException', onException);
  };
}
