import { getRequestContext } from './context.js';
import { type LogDestination, stdoutDestination } from './destinations.js';
import { configError } from './errors.js';
import {
  LOG_LEVEL_NAMES,
  LOG_LEVELS,
  type LogLevel,
  type LogLevelSetting,
  levelValue,
} from './levels.js';
import type { Clock, LoggerLike } from './ports.js';
import { defaultColors, formatPretty, type PrettyOptions } from './pretty.js';
import { createRedactor, type RedactOptions, type Redactor, sanitize } from './serialize.js';

/**
 * Pino-compatible log method: `log(obj, msg?)`, `log(err, msg?)` or `log(msg)`. An Error as
 * the first argument is logged under `err`.
 */
export type LogFn = (objOrMsg: Record<string, unknown> | Error | string, msg?: string) => void;

export interface Logger extends LoggerLike {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  /** Current level. Assigning changes the level of this logger (not of its parent). */
  level: LogLevelSetting;
  isLevelEnabled(level: LogLevel): boolean;
  /** Creates a logger whose lines carry these bindings in addition to the parent's. */
  child(bindings: Record<string, unknown>, options?: { level?: LogLevelSetting }): Logger;
  /** Returns the (redacted) bindings of this logger. */
  bindings(): Record<string, unknown>;
  /** Flushes a buffered destination. */
  flush(): void;
}

export interface LoggerOptions {
  /** Minimum level. Default `info`. */
  level?: LogLevelSetting;
  /** Fields added to every line (for example `service`, `version`). */
  bindings?: Record<string, unknown>;
  /** Redaction: a list of paths, or options. Default keys (passwords, tokens) always apply unless `defaults: false`. */
  redact?: RedactOptions | readonly string[];
  /** Destination. Default stdout. */
  destination?: LogDestination;
  /** Human-readable output instead of JSON lines (development). Default false. */
  pretty?: boolean | PrettyOptions;
  /** Add requestId, traceId and spanId from the active request context. Default true. */
  context?: boolean;
  /** Called for every enabled line; the returned fields are merged (for example OpenTelemetry span IDs). */
  mixin?: () => Record<string, unknown> | undefined;
  /** Include error stacks. Default true. */
  errorStack?: boolean;
  /** Time format: ISO 8601 string or epoch milliseconds. Default `iso`. */
  time?: 'iso' | 'epoch';
  clock?: Clock;
}

interface SharedState {
  destination: LogDestination;
  redactor: Redactor;
  pretty: false | { colors: boolean };
  context: boolean;
  mixin: (() => Record<string, unknown> | undefined) | undefined;
  errorStack: boolean;
  timeFormat: 'iso' | 'epoch';
  clock: Clock;
}

const RESERVED = new Set(['time', 'level', 'msg']);
const noop: LogFn = () => {};
const systemClock: Clock = { now: () => Date.now() };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeRecord(
  value: Record<string, unknown>,
  shared: SharedState,
): Record<string, unknown> {
  const out = sanitize(value, { redactor: shared.redactor, errorStack: shared.errorStack });
  return isPlainRecord(out) ? out : {};
}

function innerJson(record: Record<string, unknown>): string {
  const json = JSON.stringify(record);
  return json.length > 2 ? json.slice(1, -1) : '';
}

/**
 * Creates a structured logger that writes one JSON object per line:
 * `{"time":"...","level":"info","msg":"...", ...bindings, requestId, traceId, spanId, ...fields}`.
 * Disabled levels are no-op functions, so filtered calls cost one function call.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  levelValue(level);
  if (options.bindings !== undefined && !isPlainRecord(options.bindings)) {
    throw configError('bindings', 'must be an object');
  }
  if (options.mixin !== undefined && typeof options.mixin !== 'function') {
    throw configError('mixin', 'must be a function');
  }
  if (options.time !== undefined && options.time !== 'iso' && options.time !== 'epoch') {
    throw configError('time', 'must be "iso" or "epoch"');
  }
  const destination = options.destination ?? stdoutDestination();
  if (typeof destination.write !== 'function') {
    throw configError('destination', 'must have a write(line) method');
  }
  const pretty =
    options.pretty === undefined || options.pretty === false
      ? false
      : {
          colors: (options.pretty === true ? undefined : options.pretty.colors) ?? defaultColors(),
        };
  const shared: SharedState = {
    destination,
    redactor: createRedactor(options.redact ?? {}),
    pretty,
    context: options.context ?? true,
    mixin: options.mixin,
    errorStack: options.errorStack ?? true,
    timeFormat: options.time ?? 'iso',
    clock: options.clock ?? systemClock,
  };
  const bindings = sanitizeRecord(options.bindings ?? {}, shared);
  return buildLogger(shared, bindings, level);
}

function buildLogger(
  shared: SharedState,
  bindings: Record<string, unknown>,
  initialLevel: LogLevelSetting,
): Logger {
  const bindingsChunk = innerJson(bindings);
  const bindingKeys = new Set(Object.keys(bindings));
  let current: LogLevelSetting = initialLevel;
  let threshold = levelValue(initialLevel);

  const write = (
    lvl: LogLevel,
    objOrMsg: Record<string, unknown> | Error | string,
    msg?: string,
  ): void => {
    let fields: Record<string, unknown> | undefined;
    let message: string | undefined;
    if (typeof objOrMsg === 'string') {
      message = objOrMsg;
    } else if (objOrMsg instanceof Error) {
      fields = { err: objOrMsg };
      message = msg ?? objOrMsg.message;
    } else if (isPlainRecord(objOrMsg)) {
      fields = objOrMsg;
      if (msg !== undefined) message = msg;
      else if (typeof objOrMsg.msg === 'string') message = objOrMsg.msg;
      else if (objOrMsg.err instanceof Error) message = objOrMsg.err.message;
    } else {
      message = msg;
    }

    let dynamic: Record<string, unknown> | undefined;
    if (shared.context) {
      const ctx = getRequestContext();
      if (ctx) {
        dynamic = { requestId: ctx.requestId };
        if (ctx.traceId !== undefined) dynamic.traceId = ctx.traceId;
        if (ctx.spanId !== undefined) dynamic.spanId = ctx.spanId;
        for (const key of Object.keys(ctx.bindings)) dynamic[key] = ctx.bindings[key];
      }
    }
    if (shared.mixin) {
      let extra: Record<string, unknown> | undefined;
      try {
        extra = shared.mixin();
      } catch {
        extra = undefined;
      }
      if (isPlainRecord(extra)) dynamic = dynamic ? Object.assign(dynamic, extra) : { ...extra };
    }
    if (fields) {
      if (dynamic) {
        for (const key of Object.keys(fields)) dynamic[key] = fields[key];
      } else {
        dynamic = fields;
      }
    }

    const timeValue = shared.clock.now();
    let dynamicRecord: Record<string, unknown> = {};
    let overlaps = false;
    if (dynamic) {
      const filtered: Record<string, unknown> = {};
      for (const key of Object.keys(dynamic)) {
        if (RESERVED.has(key)) continue;
        if (bindingKeys.has(key)) overlaps = true;
        filtered[key] = dynamic[key];
      }
      dynamicRecord = sanitizeRecord(filtered, shared);
    }

    if (shared.pretty) {
      const record: Record<string, unknown> = { ...bindings, ...dynamicRecord };
      if (message !== undefined) record.msg = message;
      shared.destination.write(formatPretty(record, lvl, timeValue, shared.pretty.colors));
      return;
    }

    const time =
      shared.timeFormat === 'iso' ? `"${new Date(timeValue).toISOString()}"` : String(timeValue);
    let line = `{"time":${time},"level":"${lvl}"`;
    if (message !== undefined) line += `,"msg":${JSON.stringify(message)}`;
    if (overlaps) {
      const merged = innerJson({ ...bindings, ...dynamicRecord });
      if (merged) line += `,${merged}`;
    } else {
      if (bindingsChunk) line += `,${bindingsChunk}`;
      const dyn = innerJson(dynamicRecord);
      if (dyn) line += `,${dyn}`;
    }
    shared.destination.write(`${line}}\n`);
  };

  const methodFor = (lvl: LogLevel): LogFn =>
    LOG_LEVELS[lvl] >= threshold ? (objOrMsg, msg) => write(lvl, objOrMsg, msg) : noop;

  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    get level(): LogLevelSetting {
      return current;
    },
    set level(next: LogLevelSetting) {
      threshold = levelValue(next);
      current = next;
      apply();
    },
    isLevelEnabled(lvl: LogLevel): boolean {
      return LOG_LEVELS[lvl] >= threshold;
    },
    child(
      childBindings: Record<string, unknown>,
      childOptions: { level?: LogLevelSetting } = {},
    ): Logger {
      if (!isPlainRecord(childBindings)) throw configError('child.bindings', 'must be an object');
      const merged = { ...bindings, ...sanitizeRecord(childBindings, shared) };
      return buildLogger(shared, merged, childOptions.level ?? current);
    },
    bindings(): Record<string, unknown> {
      return { ...bindings };
    },
    flush(): void {
      shared.destination.flush?.();
    },
  } satisfies Logger;

  function apply(): void {
    for (const lvl of LOG_LEVEL_NAMES) logger[lvl] = methodFor(lvl);
  }
  apply();
  return logger;
}

/** A logger that discards everything. */
export function createNoopLogger(): Logger {
  return createLogger({ level: 'silent', destination: { write: () => {} } });
}
