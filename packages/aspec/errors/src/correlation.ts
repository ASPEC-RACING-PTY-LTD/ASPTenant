import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IdGenerator } from './ports.js';

/** Accepted incoming correlation IDs: 1 to 128 characters of `A-Z a-z 0-9 . _ : -`. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CorrelationOptions {
  /** Request and response header. Default `x-request-id`. */
  header?: string;
  /** Accept a valid incoming ID from the request header. Default true. */
  trustIncoming?: boolean;
  /** Generates new IDs. Default `crypto.randomUUID`. */
  generateId?: IdGenerator;
  /** Validates incoming IDs. Default: CORRELATION_ID_PATTERN. */
  validate?: (id: string) => boolean;
}

export interface CorrelationContext {
  /** Lowercase header name used for requests and responses. */
  readonly header: string;
  /** Runs `fn` with `id` as the active correlation ID (AsyncLocalStorage). */
  run<T>(id: string, fn: () => T): T;
  /** The active correlation ID, if any. */
  getId(): string | undefined;
  /** Returns the incoming ID when trusted and valid, otherwise a newly generated ID. */
  resolve(incoming: string | readonly string[] | null | undefined): string;
}

const HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** True when `value` is a valid correlation ID under the default rules. */
export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
}

/** Creates a correlation context backed by its own AsyncLocalStorage instance. */
export function createCorrelationContext(options: CorrelationOptions = {}): CorrelationContext {
  const header = (options.header ?? 'x-request-id').toLowerCase();
  if (!HEADER_PATTERN.test(header)) {
    throw new TypeError(`correlation.header must be a valid header name (got ${header})`);
  }
  const trustIncoming = options.trustIncoming ?? true;
  const generate = options.generateId ?? randomUUID;
  const validate = options.validate ?? ((id: string) => CORRELATION_ID_PATTERN.test(id));
  const storage = new AsyncLocalStorage<string>();
  return {
    header,
    run: (id, fn) => storage.run(id, fn),
    getId: () => storage.getStore(),
    resolve(incoming) {
      const value = Array.isArray(incoming) ? incoming[0] : incoming;
      if (trustIncoming && typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length > 0 && trimmed.length <= 128 && validate(trimmed)) return trimmed;
      }
      return generate();
    },
  };
}
