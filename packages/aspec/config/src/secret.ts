import { inspect } from 'node:util';

const SECRET = Symbol('aspec.config.secret');

/** Opaque wrapper that redacts under stringification, JSON and util.inspect. */
export class Secret<T> {
  readonly [SECRET] = true as const;
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** Explicit unwrap. Prefer passing this only to trusted sinks. */
  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return '[Secret]';
  }

  toJSON(): string {
    return '[Secret]';
  }

  [inspect.custom](): string {
    return 'Secret [REDACTED]';
  }
}

export function isSecret(value: unknown): value is Secret<unknown> {
  return value instanceof Secret;
}

export function secretOf<T>(value: T): Secret<T> {
  return new Secret(value);
}

/** Deep-redacts Secret instances and known secret-marked leaves for safe logging. */
export function redactConfig<T>(config: T): unknown {
  return redactValue(config, new Set());
}

function redactValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  if (isSecret(value)) return '[Secret]';
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, seen);
  }
  return out;
}
