import { STATUS_CODES } from 'node:http';
import {
  categoryForStatus,
  type ErrorCategory,
  isAppError,
  isErrorCode,
  isErrorStatus,
} from './app-error.js';

/** Default UPPER_SNAKE code for an HTTP status. */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 406:
      return 'NOT_ACCEPTABLE';
    case 408:
      return 'REQUEST_TIMEOUT';
    case 409:
      return 'CONFLICT';
    case 410:
      return 'GONE';
    case 411:
      return 'LENGTH_REQUIRED';
    case 412:
      return 'PRECONDITION_FAILED';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 414:
      return 'URI_TOO_LONG';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 416:
      return 'RANGE_NOT_SATISFIABLE';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 428:
      return 'PRECONDITION_REQUIRED';
    case 429:
      return 'RATE_LIMITED';
    case 431:
      return 'REQUEST_HEADER_FIELDS_TOO_LARGE';
    case 500:
      return 'INTERNAL_ERROR';
    case 501:
      return 'NOT_IMPLEMENTED';
    case 502:
      return 'DEPENDENCY_FAILURE';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    case 504:
      return 'TIMEOUT';
    default:
      return status < 500 ? 'CLIENT_ERROR' : 'SERVER_ERROR';
  }
}

/** HTTP status phrase, for example `Not Found`. */
export function titleForStatus(status: number): string {
  return STATUS_CODES[status] ?? (status < 500 ? 'Client Error' : 'Server Error');
}

/** The result of mapping any thrown value to an HTTP error. */
export interface MappedError {
  status: number;
  code: string;
  title: string;
  /** Client-safe message: the error message when exposed, otherwise the title. */
  message: string;
  /** The original message (may be internal; never send it to clients unless exposed). */
  internalMessage: string;
  expose: boolean;
  category: ErrorCategory;
  /** Expected runtime condition (true) or programming defect (false). */
  operational: boolean;
  /** Unredacted details, present only when the error is exposed. */
  details: unknown;
  /** Seconds for the Retry-After header. */
  retryAfter: number | undefined;
  /** Extra headers declared by the error. */
  headers: Record<string, string>;
  /** Correlation ID carried by the error, if any. */
  correlationId: string | undefined;
  /** Name of the mapping rule that matched (useful in tests and debugging). */
  rule: MappingRule;
}

export type MappingRule =
  | 'app-error'
  | 'json-syntax'
  | 'body-parser'
  | 'fastify-validation'
  | 'timeout'
  | 'network'
  | 'error-like'
  | 'status-property'
  | 'programmer'
  | 'unknown';

/** Error classification (subset of MappedError). */
export interface ErrorClassification {
  category: ErrorCategory;
  operational: boolean;
  status: number;
  code: string;
}

type Obj = Record<string, unknown>;

const PROGRAMMER_ERROR_NAMES = new Set([
  'TypeError',
  'ReferenceError',
  'RangeError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AssertionError',
]);

const DEPENDENCY_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT']);

/** Fastify content parser errors with client-safe replacement messages. */
const FASTIFY_BODY_ERRORS: Record<string, { code: string; message: string }> = {
  FST_ERR_CTP_INVALID_JSON_BODY: {
    code: 'INVALID_JSON',
    message: 'Request body is not valid JSON',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: { code: 'BAD_REQUEST', message: 'Request body is empty' },
  FST_ERR_CTP_BODY_TOO_LARGE: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload Too Large' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'Unsupported Media Type',
  },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { code: 'BAD_REQUEST', message: 'Invalid Content-Length' },
};

function asObject(err: unknown): Obj | undefined {
  return typeof err === 'object' && err !== null ? (err as Obj) : undefined;
}

function stringProp(o: Obj | undefined, key: string): string | undefined {
  const v = o?.[key];
  return typeof v === 'string' ? v : undefined;
}

function retryAfterOf(o: Obj | undefined): number | undefined {
  if (!o) return undefined;
  const s = o.retryAfter;
  if (typeof s === 'number' && Number.isFinite(s) && s >= 0) return Math.ceil(s);
  const ms = o.retryAfterMs;
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) return Math.ceil(ms / 1000);
  return undefined;
}

function headersOf(o: Obj | undefined): Record<string, string> {
  const h = o?.headers;
  if (typeof h !== 'object' || h === null || Array.isArray(h)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === 'string' && /^[A-Za-z0-9-]+$/.test(k)) out[k.toLowerCase()] = v;
  }
  return out;
}

function build(
  status: number,
  fields: Partial<Omit<MappedError, 'status' | 'title' | 'message'>> & {
    rule: MappingRule;
    internalMessage: string;
    title?: string | undefined;
    exposeMessage?: string;
  },
): MappedError {
  const title = fields.title ?? titleForStatus(status);
  const expose = fields.expose ?? false;
  return {
    status,
    code: fields.code ?? codeForStatus(status),
    title,
    message: expose ? (fields.exposeMessage ?? fields.internalMessage) || title : title,
    internalMessage: fields.internalMessage,
    expose,
    category: fields.category ?? categoryForStatus(status),
    operational: fields.operational ?? status < 500,
    details: expose ? fields.details : undefined,
    retryAfter: fields.retryAfter,
    headers: fields.headers ?? {},
    correlationId: fields.correlationId,
    rule: fields.rule,
  };
}

/**
 * Maps any thrown value to an HTTP error description. Rules, in order:
 * AppError; JSON SyntaxError from body parsing (400); body-parser and Fastify content errors;
 * AbortError and TimeoutError (504); network errors (502); ErrorLike with `status` (and
 * `code`/`expose`); objects with `status` or `statusCode`; everything else (500, generic).
 */
export function mapError(err: unknown): MappedError {
  const o = asObject(err);
  const internalMessage =
    err instanceof Error
      ? err.message
      : typeof o?.message === 'string'
        ? o.message
        : typeof err === 'string'
          ? err
          : '';
  const correlationId = stringProp(o, 'correlationId');

  if (isAppError(err)) {
    return build(err.status, {
      rule: 'app-error',
      code: err.code,
      title: err.title,
      internalMessage: err.message,
      expose: err.expose,
      category: err.category,
      operational: err.operational,
      details: err.details,
      retryAfter: err.retryAfter,
      headers: { ...err.headers },
      correlationId: err.correlationId,
    });
  }

  const name = stringProp(o, 'name') ?? '';
  const type = stringProp(o, 'type');
  const rawStatus = o?.status ?? o?.statusCode;
  const statusProp = isErrorStatus(rawStatus) ? rawStatus : undefined;
  const code = stringProp(o, 'code');

  // JSON parse failures from body parsers (Express body-parser, Fastify content parser).
  if (
    (err instanceof SyntaxError || name === 'SyntaxError') &&
    (type === 'entity.parse.failed' || statusProp === 400 || (o !== undefined && 'body' in o))
  ) {
    return build(400, {
      rule: 'json-syntax',
      code: 'INVALID_JSON',
      internalMessage,
      expose: true,
      exposeMessage: 'Request body is not valid JSON',
      category: 'client',
      operational: true,
      correlationId,
    });
  }

  const fastifyBody = code !== undefined ? FASTIFY_BODY_ERRORS[code] : undefined;
  if (fastifyBody !== undefined && statusProp !== undefined) {
    return build(statusProp, {
      rule: fastifyBody.code === 'INVALID_JSON' ? 'json-syntax' : 'body-parser',
      code: fastifyBody.code,
      internalMessage,
      expose: true,
      exposeMessage: fastifyBody.message,
      category: 'client',
      operational: true,
      correlationId,
    });
  }

  if (type !== undefined && statusProp !== undefined && type.includes('.')) {
    const bodyParserCodes: Record<string, string> = {
      'entity.too.large': 'PAYLOAD_TOO_LARGE',
      'encoding.unsupported': 'UNSUPPORTED_MEDIA_TYPE',
      'charset.unsupported': 'UNSUPPORTED_MEDIA_TYPE',
      'request.aborted': 'REQUEST_ABORTED',
      'request.size.invalid': 'BAD_REQUEST',
      'stream.encoding.set': 'INTERNAL_ERROR',
      'parameters.too.many': 'PAYLOAD_TOO_LARGE',
    };
    const mapped = bodyParserCodes[type];
    if (mapped !== undefined) {
      return build(statusProp, {
        rule: 'body-parser',
        code: mapped,
        internalMessage,
        expose: statusProp < 500,
        exposeMessage: titleForStatus(statusProp),
        correlationId,
      });
    }
  }

  if (code === 'FST_ERR_VALIDATION' && Array.isArray(o?.validation)) {
    const issues = (o.validation as unknown[]).slice(0, 100).map((v) => {
      const item = asObject(v) ?? {};
      return {
        path: typeof item.instancePath === 'string' ? item.instancePath : '',
        message: typeof item.message === 'string' ? item.message : 'Invalid value',
        code: typeof item.keyword === 'string' ? item.keyword : 'invalid',
      };
    });
    return build(400, {
      rule: 'fastify-validation',
      code: 'VALIDATION_FAILED',
      internalMessage,
      expose: true,
      exposeMessage: 'Request validation failed',
      category: 'validation',
      operational: true,
      details: { issues },
      correlationId,
    });
  }

  if (name === 'TimeoutError' || name === 'AbortError' || (code && TIMEOUT_CODES.has(code))) {
    return build(504, {
      rule: 'timeout',
      code: 'TIMEOUT',
      internalMessage,
      expose: true,
      exposeMessage: 'The operation timed out',
      category: 'timeout',
      operational: true,
      correlationId,
    });
  }

  if (code && DEPENDENCY_CODES.has(code) && statusProp === undefined) {
    return build(502, {
      rule: 'network',
      code: 'DEPENDENCY_FAILURE',
      internalMessage,
      expose: false,
      category: 'dependency',
      operational: true,
      correlationId,
    });
  }

  // ErrorLike from ASPEC modules and similar libraries: code + status + expose.
  if (o !== undefined && isErrorStatus(o.status)) {
    const status = o.status;
    return build(status, {
      rule: 'error-like',
      code: isErrorCode(code) ? code : codeForStatus(status),
      internalMessage,
      expose: o.expose === true,
      details: o.details,
      retryAfter: retryAfterOf(o),
      headers: headersOf(o),
      correlationId,
    });
  }

  // Libraries that only set statusCode (Fastify errors, some HTTP clients).
  if (statusProp !== undefined) {
    return build(statusProp, {
      rule: 'status-property',
      internalMessage,
      expose: o?.expose === true,
      retryAfter: retryAfterOf(o),
      correlationId,
    });
  }

  if (o !== undefined && isErrorCode(code) && typeof o.expose === 'boolean') {
    return build(500, {
      rule: 'error-like',
      code,
      internalMessage,
      expose: o.expose,
      details: o.details,
      operational: false,
      correlationId,
    });
  }

  const programmer = err instanceof Error && PROGRAMMER_ERROR_NAMES.has(err.name);
  return build(500, {
    rule: programmer ? 'programmer' : 'unknown',
    code: 'INTERNAL_ERROR',
    internalMessage,
    expose: false,
    category: 'internal',
    operational: false,
    correlationId,
  });
}

/**
 * Classifies an error into a category and distinguishes operational errors (expected runtime
 * conditions such as invalid input or an unavailable dependency) from programmer errors.
 */
export function classifyError(err: unknown): ErrorClassification {
  const m = mapError(err);
  return { category: m.category, operational: m.operational, status: m.status, code: m.code };
}
