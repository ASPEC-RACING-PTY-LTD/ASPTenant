import { NotFoundError } from './app-error.js';
import {
  type CorrelationContext,
  type CorrelationOptions,
  createCorrelationContext,
} from './correlation.js';
import {
  createErrorLogger,
  type DedupeOptions,
  type ErrorLogContext,
  LOG_LEVELS,
  type LogLevel,
} from './logging.js';
import { type MappedError, mapError } from './map.js';
import type { Clock, LoggerLike } from './ports.js';
import {
  type ErrorEnvelope,
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
  toErrorEnvelope,
  toProblemDetails,
} from './problem.js';
import { createRedactor, type RedactOptions } from './redact.js';

export type ErrorFormat = 'problem' | 'envelope';

export interface ErrorHandlerOptions {
  /** Response format. Default `problem` (RFC 9457 `application/problem+json`). */
  format?: ErrorFormat;
  /** Base URI for problem `type`. Default `about:blank`. */
  typeBaseUri?: string;
  /** Include debug information in responses. Ignored in production. Default false. */
  debug?: boolean;
  /** Environment name. Default `process.env.NODE_ENV`, `production` when unset. */
  environment?: string;
  /** Include the request path as problem `instance`. Default true. */
  includeInstance?: boolean;
  /** Logger (LoggerLike port). Default: no logging. */
  logger?: LoggerLike;
  /** Level for 4xx errors. Default `info`. 5xx errors are always logged at `error`. */
  clientErrorLevel?: LogLevel;
  /** Deduplicate repeated identical client errors in logs. Default false. */
  dedupeClientErrors?: boolean | DedupeOptions;
  /** Correlation ID options, or an existing context to share. */
  correlation?: CorrelationOptions | CorrelationContext;
  /** Redaction rules for response details and logs. */
  redact?: RedactOptions;
  /** Converts domain errors before mapping (for example wrapping ORM errors). */
  transform?: (err: unknown) => unknown;
  clock?: Clock;
}

export interface ErrorRequestInfo {
  method?: string | undefined;
  /** Request path without query string. */
  path?: string | undefined;
  /** Correlation ID resolved for the request. Default: the active context ID. */
  correlationId?: string | undefined;
}

export interface ErrorResponse {
  status: number;
  headers: Record<string, string>;
  body: ProblemDetails | ErrorEnvelope;
}

export interface ErrorHandler {
  readonly correlation: CorrelationContext;
  readonly format: ErrorFormat;
  /** Maps, logs and serialises an error. */
  handle(err: unknown, request?: ErrorRequestInfo): ErrorResponse;
  /** Maps and serialises an error without logging. */
  render(err: unknown, request?: ErrorRequestInfo): ErrorResponse;
  /** Response for an unmatched route (404). */
  notFound(request?: ErrorRequestInfo): ErrorResponse;
  /** Same as `handle`, as a Fetch API Response. */
  toResponse(err: unknown, request?: ErrorRequestInfo): Response;
  /** Serialised JSON body for an ErrorResponse. */
  serialize(response: ErrorResponse): string;
}

/** Thrown for invalid error handler options. */
export class ErrorsConfigError extends Error {
  override name = 'ErrorsConfigError';
  readonly code = 'ERRORS_INVALID_OPTION';
  readonly status = 500;
  readonly expose = false;
  readonly option: string;
  constructor(option: string, message: string) {
    super(`Invalid @aspec/errors option "${option}": ${message}`);
    this.option = option;
  }
}

function isContext(
  v: CorrelationOptions | CorrelationContext | undefined,
): v is CorrelationContext {
  return typeof v === 'object' && v !== null && typeof (v as CorrelationContext).run === 'function';
}

function validateOptions(options: ErrorHandlerOptions): void {
  if (
    options.format !== undefined &&
    options.format !== 'problem' &&
    options.format !== 'envelope'
  ) {
    throw new ErrorsConfigError('format', 'must be "problem" or "envelope"');
  }
  if (options.typeBaseUri !== undefined) {
    let url: URL;
    try {
      url = new URL(options.typeBaseUri);
    } catch {
      throw new ErrorsConfigError('typeBaseUri', 'must be an absolute URI');
    }
    if (url.search || url.hash) {
      throw new ErrorsConfigError('typeBaseUri', 'must not contain a query or fragment');
    }
  }
  if (options.clientErrorLevel !== undefined && !LOG_LEVELS.includes(options.clientErrorLevel)) {
    throw new ErrorsConfigError('clientErrorLevel', `must be one of ${LOG_LEVELS.join(', ')}`);
  }
  const d = options.dedupeClientErrors;
  if (typeof d === 'object' && d !== null) {
    if (d.windowMs !== undefined && (!Number.isFinite(d.windowMs) || d.windowMs <= 0)) {
      throw new ErrorsConfigError('dedupeClientErrors.windowMs', 'must be a positive number');
    }
    if (d.maxKeys !== undefined && (!Number.isInteger(d.maxKeys) || d.maxKeys <= 0)) {
      throw new ErrorsConfigError('dedupeClientErrors.maxKeys', 'must be a positive integer');
    }
  }
  if (options.logger !== undefined) {
    for (const m of ['debug', 'info', 'warn', 'error'] as const) {
      if (typeof options.logger[m] !== 'function') {
        throw new ErrorsConfigError('logger', `must implement ${m}(obj, msg)`);
      }
    }
  }
}

/**
 * Creates the framework-agnostic error handler used by every adapter. It maps any thrown value
 * to a safe HTTP response (problem details or JSON envelope), logs it through the LoggerLike
 * port and attaches the correlation ID.
 */
export function createErrorHandler(options: ErrorHandlerOptions = {}): ErrorHandler {
  validateOptions(options);
  const format = options.format ?? 'problem';
  const includeInstance = options.includeInstance ?? true;
  const redactor = createRedactor(options.redact);
  const correlation = isContext(options.correlation)
    ? options.correlation
    : createCorrelationContext(options.correlation);
  const errorLogger = createErrorLogger({
    redactor,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.clientErrorLevel ? { clientErrorLevel: options.clientErrorLevel } : {}),
    ...(options.dedupeClientErrors !== undefined
      ? { dedupeClientErrors: options.dedupeClientErrors }
      : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const contentType =
    format === 'problem'
      ? `${PROBLEM_CONTENT_TYPE}; charset=utf-8`
      : 'application/json; charset=utf-8';

  const build = (err: unknown, mapped: MappedError, request: ErrorRequestInfo): ErrorResponse => {
    const correlationId = request.correlationId ?? correlation.getId() ?? mapped.correlationId;
    const serializeOptions = {
      redactor,
      ...(options.typeBaseUri !== undefined ? { typeBaseUri: options.typeBaseUri } : {}),
      ...(options.debug !== undefined ? { debug: options.debug } : {}),
      ...(options.environment !== undefined ? { environment: options.environment } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(includeInstance && request.path !== undefined ? { instance: request.path } : {}),
    };
    const body =
      format === 'problem'
        ? toProblemDetails(err, serializeOptions, mapped)
        : toErrorEnvelope(err, serializeOptions, mapped);
    const headers: Record<string, string> = {
      ...mapped.headers,
      'content-type': contentType,
      'cache-control': 'no-store',
    };
    if (correlationId !== undefined) headers[correlation.header] = correlationId;
    if (mapped.retryAfter !== undefined) headers['retry-after'] = String(mapped.retryAfter);
    return { status: mapped.status, headers, body };
  };

  const prepare = (err: unknown): { value: unknown; mapped: MappedError } => {
    let value = err;
    if (options.transform) {
      try {
        value = options.transform(err);
      } catch (transformError) {
        value = transformError;
      }
    }
    return { value, mapped: mapError(value) };
  };

  const handler: ErrorHandler = {
    correlation,
    format,
    handle(err, request = {}) {
      const { value, mapped } = prepare(err);
      const context: ErrorLogContext = {
        correlationId: request.correlationId ?? correlation.getId(),
        method: request.method,
        path: request.path,
      };
      try {
        errorLogger.log(value, mapped, context);
      } catch {
        // A failing logger must never prevent the error response.
      }
      return build(value, mapped, request);
    },
    render(err, request = {}) {
      const { value, mapped } = prepare(err);
      return build(value, mapped, request);
    },
    notFound(request = {}) {
      const err = new NotFoundError(
        request.path !== undefined
          ? `No route matches ${request.method ?? 'GET'} ${request.path}`
          : 'Not found',
      );
      return build(err, mapError(err), request);
    },
    toResponse(err, request) {
      const r = handler.handle(err, request);
      return new Response(handler.serialize(r), { status: r.status, headers: r.headers });
    },
    serialize(response) {
      return JSON.stringify(response.body);
    },
  };
  return handler;
}
