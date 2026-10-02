import { STATUS_CODES } from 'node:http';
import type { ValidationIssue } from './issues.js';

export type ValidationStatus = 400 | 422;

export interface ValidationErrorOptions {
  /** HTTP status. Default 400. */
  status?: ValidationStatus;
  /** Message. Default `Validation failed`. */
  message?: string;
  cause?: unknown;
}

/**
 * Standardised validation error. Satisfies the ErrorLike port (`code`, `status`, `expose`,
 * `details`) so @aspec/errors and other error handlers can render it without importing it.
 */
export class ValidationError extends Error {
  override name = 'ValidationError';
  readonly code = 'VALIDATION_FAILED';
  readonly status: ValidationStatus;
  readonly expose = true;
  readonly details: { issues: ValidationIssue[] };

  constructor(issues: readonly ValidationIssue[], options: ValidationErrorOptions = {}) {
    super(
      options.message ?? 'Validation failed',
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    const status = options.status ?? 400;
    if (status !== 400 && status !== 422) {
      throw new TypeError('ValidationError status must be 400 or 422');
    }
    this.status = status;
    this.details = { issues: [...issues] };
  }

  get issues(): ValidationIssue[] {
    return this.details.issues;
  }
}

/** Codes of RequestBodyError. */
export type RequestBodyErrorCode =
  | 'VALIDATION_BODY_TOO_LARGE'
  | 'VALIDATION_INVALID_JSON'
  | 'VALIDATION_UNSUPPORTED_MEDIA_TYPE';

const BODY_ERROR_STATUS: Record<RequestBodyErrorCode, number> = {
  VALIDATION_BODY_TOO_LARGE: 413,
  VALIDATION_INVALID_JSON: 400,
  VALIDATION_UNSUPPORTED_MEDIA_TYPE: 415,
};

/** Request body could not be read or parsed (size limit, malformed JSON, media type). */
export class RequestBodyError extends Error {
  override name = 'RequestBodyError';
  readonly code: RequestBodyErrorCode;
  readonly status: number;
  readonly expose = true;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: RequestBodyErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = BODY_ERROR_STATUS[code];
    this.details = details;
  }
}

/** A schema is unusable for the requested operation (for example async schema in validateSync). */
export class ValidationSchemaError extends Error {
  override name = 'ValidationSchemaError';
  readonly code: 'VALIDATION_ASYNC_SCHEMA' | 'VALIDATION_INVALID_SCHEMA' | 'VALIDATION_NOT_RUN';
  readonly status = 500;
  readonly expose = false;

  constructor(
    code: 'VALIDATION_ASYNC_SCHEMA' | 'VALIDATION_INVALID_SCHEMA' | 'VALIDATION_NOT_RUN',
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

/** RFC 9457 problem details for validation and body errors. */
export interface ValidationProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  instance?: string;
  /** Validation issues (extension member). */
  errors?: ValidationIssue[];
}

export interface ProblemDetailsOptions {
  /** Problem `type` URI. Default `about:blank`. */
  type?: string;
  /** Problem `instance` (usually the request path). */
  instance?: string;
}

/** Media type for problem details responses. */
export const PROBLEM_JSON = 'application/problem+json';

/**
 * Converts a ValidationError or RequestBodyError to RFC 9457 problem details
 * (`application/problem+json`) with the issues in the `errors` extension member.
 */
export function toProblemDetails(
  error: ValidationError | RequestBodyError,
  options: ProblemDetailsOptions = {},
): ValidationProblemDetails {
  const problem: ValidationProblemDetails = {
    type: options.type ?? 'about:blank',
    title: STATUS_CODES[error.status] ?? 'Bad Request',
    status: error.status,
    detail: error.message,
    code: error.code,
  };
  if (options.instance !== undefined) problem.instance = options.instance;
  if (error instanceof ValidationError) problem.errors = error.issues;
  return problem;
}
