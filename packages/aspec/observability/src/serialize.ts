import { configError } from './errors.js';

/**
 * Keys redacted by default wherever they appear (case-insensitive, `-` and `_` ignored), so
 * `Authorization`, `x-api-key`, `client_secret` and `refreshToken` are all covered.
 */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'clientSecret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'x-api-key',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'privateKey',
  'sessionToken',
  'x-health-token',
];

export const DEFAULT_CENSOR = '[REDACTED]';

export interface RedactOptions {
  /** Keys redacted at any depth (matching ignores case, `-` and `_`). */
  keys?: readonly string[];
  /**
   * Exact paths from the log record root, dot separated, `*` matches one segment, bracket
   * notation for keys with dots: `req.headers.authorization`, `users.*.email`, `a["b.c"]`.
   */
  paths?: readonly string[];
  /** Replacement value. Default `[REDACTED]`. */
  censor?: string;
  /** Include DEFAULT_REDACT_KEYS. Default true. */
  defaults?: boolean;
}

export interface Redactor {
  readonly censor: string;
  keyMatches(key: string): boolean;
  pathMatches(path: readonly string[]): boolean;
  readonly hasPaths: boolean;
}

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** Parses a redaction path into segments. Throws a configuration error when malformed. */
export function parseRedactPath(path: string): string[] {
  const segments: string[] = [];
  let i = 0;
  const fail = (): never => {
    throw configError('redact.paths', `malformed path "${path}"`);
  };
  if (path.length === 0 || path.length > 500) fail();
  while (i < path.length) {
    if (path[i] === '[') {
      const quote = path[i + 1];
      if (quote !== '"' && quote !== "'") fail();
      const end = path.indexOf(`${quote}]`, i + 2);
      if (end < 0) fail();
      segments.push(path.slice(i + 2, end));
      i = end + 2;
      if (i < path.length) {
        if (path[i] === '.') i++;
        else if (path[i] !== '[') fail();
      }
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
    const segment = path.slice(i, j);
    if (segment.length === 0) fail();
    segments.push(segment);
    i = j;
    if (path[i] === '.') {
      i++;
      if (i === path.length) fail();
    }
  }
  return segments;
}

export function createRedactor(options: RedactOptions | readonly string[] = {}): Redactor {
  const opts: RedactOptions = Array.isArray(options)
    ? { paths: options as readonly string[] }
    : (options as RedactOptions);
  const censor = opts.censor ?? DEFAULT_CENSOR;
  if (typeof censor !== 'string') throw configError('redact.censor', 'must be a string');
  const keys = new Set<string>();
  if (opts.defaults !== false) for (const k of DEFAULT_REDACT_KEYS) keys.add(normaliseKey(k));
  for (const k of opts.keys ?? []) {
    if (typeof k !== 'string' || k.length === 0) {
      throw configError('redact.keys', 'must contain non-empty strings');
    }
    keys.add(normaliseKey(k));
  }
  const paths = (opts.paths ?? []).map(parseRedactPath);
  return {
    censor,
    hasPaths: paths.length > 0,
    keyMatches: (key) => keys.size > 0 && keys.has(normaliseKey(key)),
    pathMatches(path) {
      for (const pattern of paths) {
        if (pattern.length !== path.length) continue;
        let match = true;
        for (let i = 0; i < pattern.length; i++) {
          if (pattern[i] !== '*' && pattern[i] !== path[i]) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }
      return false;
    },
  };
}

export interface SerializeOptions {
  redactor: Redactor;
  /** Include error stacks. Default true. */
  errorStack?: boolean;
  maxDepth?: number;
  maxArrayLength?: number;
}

export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  code?: unknown;
  status?: unknown;
  cause?: unknown;
  errors?: unknown[];
  [key: string]: unknown;
}

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_ARRAY = 1000;
const ERROR_OWN_SKIP = new Set(['name', 'message', 'stack', 'cause', 'errors']);

function errorType(err: Error): string {
  if (typeof err.name === 'string' && err.name !== 'Error') return err.name;
  const ctor = (err as { constructor?: { name?: unknown } }).constructor;
  return typeof ctor?.name === 'string' && ctor.name.length > 0 ? ctor.name : 'Error';
}

/**
 * Converts an arbitrary value into JSON-safe data: redacts configured keys and paths, breaks
 * cycles, serialises errors with their cause chain, converts bigint, Date, Map, Set and
 * binary values, and bounds depth and array length.
 */
export function sanitize(value: unknown, options: SerializeOptions, path: string[] = []): unknown {
  return walk(value, options, path, new WeakSet(), 0);
}

function walk(
  value: unknown,
  opts: SerializeOptions,
  path: string[],
  seen: WeakSet<object>,
  depth: number,
): unknown {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
      return undefined;
    case 'symbol':
      return value.toString();
  }
  if (value === null) return null;
  const obj = value as object;
  if (seen.has(obj)) return '[Circular]';
  if (depth >= (opts.maxDepth ?? DEFAULT_MAX_DEPTH)) return '[Object]';
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  if (obj instanceof Error) {
    seen.add(obj);
    const out = serializeErrorInner(obj, opts, path, seen, depth);
    seen.delete(obj);
    return out;
  }
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
    return `[Binary ${obj.byteLength} bytes]`;
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const max = opts.maxArrayLength ?? DEFAULT_MAX_ARRAY;
      const out: unknown[] = [];
      const n = Math.min(obj.length, max);
      for (let i = 0; i < n; i++) {
        const v = walkChild(obj[i], String(i), opts, path, seen, depth);
        out.push(v === undefined ? null : v);
      }
      if (obj.length > max) out.push(`[${obj.length - max} more items]`);
      return out;
    }
    if (obj instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of obj) assignField(out, String(k), v, opts, path, seen, depth);
      return out;
    }
    if (obj instanceof Set) {
      return walk([...obj], opts, path, seen, depth);
    }
    const toJSON = (obj as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      seen.delete(obj);
      return walk(toJSON.call(obj), opts, path, seen, depth + 1);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      assignField(out, key, (obj as Record<string, unknown>)[key], opts, path, seen, depth);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

function walkChild(
  value: unknown,
  key: string,
  opts: SerializeOptions,
  path: string[],
  seen: WeakSet<object>,
  depth: number,
): unknown {
  path.push(key);
  try {
    if (
      opts.redactor.keyMatches(key) ||
      (opts.redactor.hasPaths && opts.redactor.pathMatches(path))
    ) {
      return value === undefined ? undefined : opts.redactor.censor;
    }
    return walk(value, opts, path, seen, depth + 1);
  } finally {
    path.pop();
  }
}

function assignField(
  out: Record<string, unknown>,
  key: string,
  value: unknown,
  opts: SerializeOptions,
  path: string[],
  seen: WeakSet<object>,
  depth: number,
): void {
  const v = walkChild(value, key, opts, path, seen, depth);
  if (v !== undefined) out[key] = v;
}

function serializeErrorInner(
  err: Error,
  opts: SerializeOptions,
  path: string[],
  seen: WeakSet<object>,
  depth: number,
): SerializedError {
  const out: SerializedError = {
    type: errorType(err),
    message: typeof err.message === 'string' ? err.message : String(err.message),
  };
  if (opts.errorStack !== false && typeof err.stack === 'string') out.stack = err.stack;
  for (const key of Object.keys(err)) {
    if (ERROR_OWN_SKIP.has(key)) continue;
    assignField(
      out,
      key,
      (err as unknown as Record<string, unknown>)[key],
      opts,
      path,
      seen,
      depth,
    );
  }
  if (err.cause !== undefined) {
    const cause = walkChild(err.cause, 'cause', opts, path, seen, depth);
    if (cause !== undefined) out.cause = cause;
  }
  if (err instanceof AggregateError && Array.isArray(err.errors)) {
    const errors = walkChild(err.errors, 'errors', opts, path, seen, depth);
    if (Array.isArray(errors)) out.errors = errors;
  }
  return out;
}

/** Serialises an error (with its cause chain) into plain JSON data, applying redaction. */
export function serializeError(
  err: Error,
  options: Partial<SerializeOptions> = {},
): SerializedError {
  const opts: SerializeOptions = { redactor: options.redactor ?? createRedactor(), ...options };
  const seen = new WeakSet<object>();
  seen.add(err);
  return serializeErrorInner(err, opts, [], seen, 0);
}
