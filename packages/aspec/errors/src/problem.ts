import { type DebugInfo, toDebugJSON } from './debug.js';
import { type MappedError, mapError, titleForStatus } from './map.js';
import { createRedactor, type Redactor } from './redact.js';

/** Media type of RFC 9457 problem responses. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** RFC 9457 problem details with ASPEC extension members. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  /** Present only when the error is exposed (or debug output is enabled outside production). */
  detail?: string;
  instance?: string;
  code: string;
  correlationId?: string;
  /** Validation issues (from details with an `issues` array). */
  errors?: unknown[];
  /** Other safe, redacted details. */
  details?: unknown;
  /** Seconds until retry is allowed (mirrors Retry-After). */
  retryAfter?: number;
  /** Debug information; only with `debug: true` outside production. */
  debug?: DebugInfo;
}

/** Alternative JSON envelope format. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    status: number;
    correlationId?: string;
    errors?: unknown[];
    details?: unknown;
    retryAfter?: number;
    debug?: DebugInfo;
  };
}

export interface SerializeOptions {
  /** Base URI for problem `type` (for example `https://errors.example.com/`). Default `about:blank`. */
  typeBaseUri?: string;
  /** Problem `instance` (usually the request path). */
  instance?: string;
  correlationId?: string;
  /** Include debug information. Ignored when `environment` is `production`. */
  debug?: boolean;
  /** Environment name. Default `process.env.NODE_ENV`, and `production` when unset. */
  environment?: string;
  redactor?: Redactor;
}

/** True when debug output is requested and the environment is not production. */
export function isDebugAllowed(
  debug: boolean | undefined,
  environment: string | undefined,
): boolean {
  const env = environment ?? process.env.NODE_ENV ?? 'production';
  return debug === true && env !== 'production';
}

function kebab(code: string): string {
  return code.toLowerCase().replace(/_/g, '-');
}

/** Builds the problem `type` URI for a code. */
export function problemType(code: string, typeBaseUri: string | undefined): string {
  if (!typeBaseUri) return 'about:blank';
  const base = typeBaseUri.endsWith('/') ? typeBaseUri : `${typeBaseUri}/`;
  return `${base}${kebab(code)}`;
}

interface SafeParts {
  message: string | undefined;
  errors: unknown[] | undefined;
  details: unknown;
  debug: DebugInfo | undefined;
}

function safeParts(err: unknown, mapped: MappedError, options: SerializeOptions): SafeParts {
  const redactor = options.redactor ?? createRedactor();
  const debug = isDebugAllowed(options.debug, options.environment);
  let errors: unknown[] | undefined;
  let details: unknown;
  if (mapped.expose && mapped.details !== undefined) {
    const d = mapped.details;
    if (typeof d === 'object' && d !== null && Array.isArray((d as { issues?: unknown }).issues)) {
      const { issues, ...rest } = d as { issues: unknown[] };
      errors = redactor(issues) as unknown[];
      if (Object.keys(rest).length > 0) details = redactor(rest);
    } else {
      details = redactor(d);
    }
  }
  let message: string | undefined;
  if (mapped.expose) message = redactor.string(mapped.message);
  else if (debug && mapped.internalMessage) message = redactor.string(mapped.internalMessage);
  return {
    message,
    errors,
    details,
    debug: debug ? toDebugJSON(err, { redactor }) : undefined,
  };
}

/** Serialises an error as RFC 9457 problem details (safe for clients). */
export function toProblemDetails(
  err: unknown,
  options: SerializeOptions = {},
  mapped: MappedError = mapError(err),
): ProblemDetails {
  const parts = safeParts(err, mapped, options);
  const typeUri = problemType(mapped.code, options.typeBaseUri);
  const problem: ProblemDetails = {
    type: typeUri,
    title: typeUri === 'about:blank' ? titleForStatus(mapped.status) : mapped.title,
    status: mapped.status,
    code: mapped.code,
  };
  if (parts.message !== undefined && parts.message !== problem.title)
    problem.detail = parts.message;
  if (options.instance !== undefined) problem.instance = options.instance;
  const correlationId = options.correlationId ?? mapped.correlationId;
  if (correlationId !== undefined) problem.correlationId = correlationId;
  if (parts.errors !== undefined) problem.errors = parts.errors;
  if (parts.details !== undefined) problem.details = parts.details;
  if (mapped.retryAfter !== undefined) problem.retryAfter = mapped.retryAfter;
  if (parts.debug !== undefined) problem.debug = parts.debug;
  return problem;
}

/** Serialises an error as `{ error: { code, message, status, ... } }` (safe for clients). */
export function toErrorEnvelope(
  err: unknown,
  options: SerializeOptions = {},
  mapped: MappedError = mapError(err),
): ErrorEnvelope {
  const parts = safeParts(err, mapped, options);
  const body: ErrorEnvelope['error'] = {
    code: mapped.code,
    message: parts.message ?? mapped.title,
    status: mapped.status,
  };
  const correlationId = options.correlationId ?? mapped.correlationId;
  if (correlationId !== undefined) body.correlationId = correlationId;
  if (parts.errors !== undefined) body.errors = parts.errors;
  if (parts.details !== undefined) body.details = parts.details;
  if (mapped.retryAfter !== undefined) body.retryAfter = mapped.retryAfter;
  if (parts.debug !== undefined) body.debug = parts.debug;
  return { error: body };
}
