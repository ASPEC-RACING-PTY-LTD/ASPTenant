import type { ErrorLike } from './ports.js';

/** Error categories produced by classification. */
export const ERROR_CATEGORIES = [
  'client',
  'authentication',
  'authorisation',
  'not_found',
  'conflict',
  'validation',
  'rate_limit',
  'dependency',
  'timeout',
  'internal',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const APP_ERROR_BRAND = Symbol.for('aspec.errors.AppError');

/** Returns true when `code` is an UPPER_SNAKE error code. */
export function isErrorCode(code: unknown): code is string {
  return typeof code === 'string' && code.length <= 100 && CODE_PATTERN.test(code);
}

/** Returns true when `status` is an integer HTTP error status (400 to 599). */
export function isErrorStatus(status: unknown): status is number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
}

/** Default category for an HTTP status. */
export function categoryForStatus(status: number): ErrorCategory {
  switch (status) {
    case 401:
      return 'authentication';
    case 403:
      return 'authorisation';
    case 404:
    case 410:
      return 'not_found';
    case 409:
      return 'conflict';
    case 422:
      return 'validation';
    case 429:
      return 'rate_limit';
    case 408:
    case 504:
      return 'timeout';
    case 502:
    case 503:
      return 'dependency';
    default:
      return status < 500 ? 'client' : 'internal';
  }
}

export interface AppErrorOptions {
  /** UPPER_SNAKE code. Default `INTERNAL_ERROR`. */
  code?: string;
  /** HTTP status (400 to 599). Default 500. */
  status?: number;
  /** Message is safe to show to clients. Default: true for 4xx, false for 5xx. */
  expose?: boolean;
  /** Structured details. Sent to clients only when `expose` is true (and always redacted). */
  details?: unknown;
  /** Underlying error. Never sent to clients. */
  cause?: unknown;
  /** Correlation ID of the request that produced the error. */
  correlationId?: string;
  /** Classification category. Default derived from the status. */
  category?: ErrorCategory;
  /** Expected runtime condition (true) or programming defect (false). Default: status < 500. */
  operational?: boolean;
  /** Short human title for problem responses. Default: HTTP status phrase. */
  title?: string;
  /** Seconds after which the client may retry (Retry-After header). */
  retryAfter?: number;
  /** Extra response headers (for example WWW-Authenticate). */
  headers?: Readonly<Record<string, string>>;
}

/**
 * Base class for typed application errors. Satisfies the ErrorLike port.
 */
export class AppError extends Error implements ErrorLike {
  override name = 'AppError';
  readonly code: string;
  readonly status: number;
  readonly expose: boolean;
  readonly details: unknown;
  readonly category: ErrorCategory;
  readonly operational: boolean;
  readonly title: string | undefined;
  readonly retryAfter: number | undefined;
  readonly headers: Readonly<Record<string, string>>;
  correlationId: string | undefined;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    const code = options.code ?? 'INTERNAL_ERROR';
    if (!isErrorCode(code)) {
      throw new TypeError(`AppError code must be UPPER_SNAKE (got ${JSON.stringify(code)})`);
    }
    const status = options.status ?? 500;
    if (!isErrorStatus(status)) {
      throw new TypeError(`AppError status must be an integer from 400 to 599 (got ${status})`);
    }
    if (
      options.retryAfter !== undefined &&
      (!Number.isFinite(options.retryAfter) || options.retryAfter < 0)
    ) {
      throw new TypeError('AppError retryAfter must be a non-negative number of seconds');
    }
    this.code = code;
    this.status = status;
    this.expose = options.expose ?? status < 500;
    this.details = options.details;
    this.category = options.category ?? categoryForStatus(status);
    this.operational = options.operational ?? status < 500;
    this.title = options.title;
    this.retryAfter = options.retryAfter;
    this.headers = options.headers ?? {};
    this.correlationId = options.correlationId;
    Object.defineProperty(this, APP_ERROR_BRAND, { value: true });
  }

  /** Client-safe JSON form (never includes stack, cause or unexposed data). */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { name: this.name, code: this.code, status: this.status };
    if (this.expose) {
      out.message = this.message;
      if (this.details !== undefined) out.details = this.details;
    }
    if (this.correlationId !== undefined) out.correlationId = this.correlationId;
    return out;
  }
}

/** Options for the built-in typed errors (status and category are fixed by the class). */
export type TypedErrorOptions = Omit<AppErrorOptions, 'status'>;

function typed(
  defaults: {
    code: string;
    status: number;
    category: ErrorCategory;
    expose: boolean;
    operational?: boolean;
  },
  options: TypedErrorOptions,
): AppErrorOptions {
  return {
    ...options,
    code: options.code ?? defaults.code,
    status: defaults.status,
    category: options.category ?? defaults.category,
    expose: options.expose ?? defaults.expose,
    operational: options.operational ?? defaults.operational ?? defaults.status < 500,
  };
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', options: TypedErrorOptions = {}) {
    super(
      message,
      typed({ code: 'BAD_REQUEST', status: 400, category: 'client', expose: true }, options),
    );
    this.name = 'BadRequestError';
  }
}

export interface UnauthorizedErrorOptions extends TypedErrorOptions {
  /** Value of the WWW-Authenticate response header, for example `Bearer realm="api"`. */
  challenge?: string;
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', options: UnauthorizedErrorOptions = {}) {
    const { challenge, ...rest } = options;
    const headers =
      challenge === undefined ? rest.headers : { ...rest.headers, 'www-authenticate': challenge };
    super(
      message,
      typed(
        { code: 'UNAUTHORIZED', status: 401, category: 'authentication', expose: true },
        headers === undefined ? rest : { ...rest, headers },
      ),
    );
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied', options: TypedErrorOptions = {}) {
    super(
      message,
      typed({ code: 'FORBIDDEN', status: 403, category: 'authorisation', expose: true }, options),
    );
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', options: TypedErrorOptions = {}) {
    super(
      message,
      typed({ code: 'NOT_FOUND', status: 404, category: 'not_found', expose: true }, options),
    );
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict', options: TypedErrorOptions = {}) {
    super(
      message,
      typed({ code: 'CONFLICT', status: 409, category: 'conflict', expose: true }, options),
    );
    this.name = 'ConflictError';
  }
}

export class GoneError extends AppError {
  constructor(message = 'Resource is no longer available', options: TypedErrorOptions = {}) {
    super(
      message,
      typed({ code: 'GONE', status: 410, category: 'not_found', expose: true }, options),
    );
    this.name = 'GoneError';
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request payload is too large', options: TypedErrorOptions = {}) {
    super(
      message,
      typed({ code: 'PAYLOAD_TOO_LARGE', status: 413, category: 'client', expose: true }, options),
    );
    this.name = 'PayloadTooLargeError';
  }
}

export class UnprocessableError extends AppError {
  constructor(message = 'Request could not be processed', options: TypedErrorOptions = {}) {
    super(
      message,
      typed(
        { code: 'UNPROCESSABLE_ENTITY', status: 422, category: 'validation', expose: true },
        options,
      ),
    );
    this.name = 'UnprocessableError';
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests', options: TypedErrorOptions = {}) {
    super(
      message,
      typed({ code: 'RATE_LIMITED', status: 429, category: 'rate_limit', expose: true }, options),
    );
    this.name = 'RateLimitedError';
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error', options: TypedErrorOptions = {}) {
    super(
      message,
      typed(
        {
          code: 'INTERNAL_ERROR',
          status: 500,
          category: 'internal',
          expose: false,
          operational: false,
        },
        options,
      ),
    );
    this.name = 'InternalError';
  }
}

export class NotImplementedError extends AppError {
  constructor(message = 'Not implemented', options: TypedErrorOptions = {}) {
    super(
      message,
      typed(
        {
          code: 'NOT_IMPLEMENTED',
          status: 501,
          category: 'internal',
          expose: true,
          operational: true,
        },
        options,
      ),
    );
    this.name = 'NotImplementedError';
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', options: TypedErrorOptions = {}) {
    super(
      message,
      typed(
        {
          code: 'SERVICE_UNAVAILABLE',
          status: 503,
          category: 'dependency',
          expose: true,
          operational: true,
        },
        options,
      ),
    );
    this.name = 'ServiceUnavailableError';
  }
}

export class TimeoutError extends AppError {
  constructor(message = 'The operation timed out', options: TypedErrorOptions = {}) {
    super(
      message,
      typed(
        { code: 'TIMEOUT', status: 504, category: 'timeout', expose: true, operational: true },
        options,
      ),
    );
    this.name = 'TimeoutError';
  }
}

export class DependencyFailureError extends AppError {
  constructor(message = 'A dependency failed', options: TypedErrorOptions = {}) {
    super(
      message,
      typed(
        {
          code: 'DEPENDENCY_FAILURE',
          status: 502,
          category: 'dependency',
          expose: false,
          operational: true,
        },
        options,
      ),
    );
    this.name = 'DependencyFailureError';
  }
}

export interface DefineErrorOptions {
  /** HTTP status (400 to 599). */
  status: number;
  /** Message is safe for clients. Default: true for 4xx, false for 5xx. */
  expose?: boolean;
  /** Category. Default derived from the status. */
  category?: ErrorCategory;
  /** Default message when none is passed to the constructor. */
  message?: string;
  /** Problem title. Default: HTTP status phrase. */
  title?: string;
  /** Class name. Default: PascalCase of the code plus `Error`. */
  name?: string;
  /** Operational error. Default: status < 500. */
  operational?: boolean;
}

export type DefinedErrorOptions = Omit<AppErrorOptions, 'code' | 'status' | 'category'>;

export interface DefinedError<C extends string> extends AppError {
  readonly code: C;
}

export interface DefinedErrorClass<C extends string> {
  new (message?: string, options?: DefinedErrorOptions): DefinedError<C>;
  readonly code: C;
  readonly status: number;
  /** Type guard that also matches instances from another copy of the class (by code). */
  is(err: unknown): err is DefinedError<C>;
}

function pascal(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Defines an application-specific typed error class with `instanceof` support.
 *
 * ```ts
 * const EmailTaken = defineError('USER_EMAIL_TAKEN', { status: 409, message: 'Email already in use' });
 * throw new EmailTaken();
 * ```
 */
export function defineError<const C extends string>(
  code: C,
  definition: DefineErrorOptions,
): DefinedErrorClass<C> {
  if (!isErrorCode(code)) {
    throw new TypeError(`defineError code must be UPPER_SNAKE (got ${JSON.stringify(code)})`);
  }
  if (!isErrorStatus(definition.status)) {
    throw new TypeError(`defineError status must be an integer from 400 to 599 for ${code}`);
  }
  const className = definition.name ?? `${pascal(code)}Error`;
  const status = definition.status;
  const Defined = class extends AppError {
    static readonly code = code;
    static readonly status = status;
    declare readonly code: C;
    constructor(message?: string, options: DefinedErrorOptions = {}) {
      const base: AppErrorOptions = {
        ...options,
        code,
        status,
        expose: options.expose ?? definition.expose ?? status < 500,
        operational: options.operational ?? definition.operational ?? status < 500,
      };
      if (definition.category !== undefined) base.category = definition.category;
      if (definition.title !== undefined && options.title === undefined)
        base.title = definition.title;
      super(message ?? definition.message ?? pascal(code), base);
      this.name = className;
    }
    static is(err: unknown): err is DefinedError<C> {
      return isAppError(err) && err.code === code;
    }
  };
  Object.defineProperty(Defined, 'name', { value: className });
  return Defined as unknown as DefinedErrorClass<C>;
}

/** True for AppError instances, including instances from another copy of this package. */
export function isAppError(err: unknown): err is AppError {
  return (
    err instanceof AppError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as Record<symbol, unknown>)[APP_ERROR_BRAND] === true)
  );
}

/** True when `err` is an object with the given `code` (structural, works for any ErrorLike). */
export function hasCode<const C extends string>(
  err: unknown,
  code: C,
): err is ErrorLike & { code: C } {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

/** True when `err` structurally satisfies the ErrorLike port. */
export function isErrorLike(err: unknown): err is ErrorLike {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return typeof e.name === 'string' && typeof e.message === 'string';
}
