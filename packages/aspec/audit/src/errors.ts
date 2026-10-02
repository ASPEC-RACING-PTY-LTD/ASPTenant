export const AUDIT_ERROR_CODES = [
  'AUDIT_INVALID_OPTIONS',
  'AUDIT_INVALID_EVENT',
  'AUDIT_EVENT_TOO_LARGE',
  'AUDIT_NOT_QUERYABLE',
  'AUDIT_INVALID_QUERY',
  'AUDIT_INVALID_CURSOR',
  'AUDIT_CHAIN_KEY_REQUIRED',
  'AUDIT_CHAIN_CONFLICT',
  'AUDIT_SINK_FAILED',
  'AUDIT_SINK_CLOSED',
  'AUDIT_QUEUE_FULL',
  'AUDIT_UNAUTHENTICATED',
  'AUDIT_FORBIDDEN',
  'AUDIT_NOT_FOUND',
] as const;

export type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[number];

const STATUS: Record<AuditErrorCode, number> = {
  AUDIT_INVALID_OPTIONS: 500,
  AUDIT_INVALID_EVENT: 500,
  AUDIT_EVENT_TOO_LARGE: 500,
  AUDIT_NOT_QUERYABLE: 501,
  AUDIT_INVALID_QUERY: 400,
  AUDIT_INVALID_CURSOR: 400,
  AUDIT_CHAIN_KEY_REQUIRED: 500,
  AUDIT_CHAIN_CONFLICT: 409,
  AUDIT_SINK_FAILED: 503,
  AUDIT_SINK_CLOSED: 503,
  AUDIT_QUEUE_FULL: 503,
  AUDIT_UNAUTHENTICATED: 401,
  AUDIT_FORBIDDEN: 403,
  AUDIT_NOT_FOUND: 404,
};

const EXPOSED: ReadonlySet<AuditErrorCode> = new Set([
  'AUDIT_INVALID_QUERY',
  'AUDIT_INVALID_CURSOR',
  'AUDIT_UNAUTHENTICATED',
  'AUDIT_FORBIDDEN',
  'AUDIT_NOT_FOUND',
]);

/** Error thrown by every part of @aspec/audit. Satisfies the ErrorLike port. */
export class AuditError extends Error {
  readonly code: AuditErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(
    code: AuditErrorCode,
    message: string,
    options: { cause?: unknown; details?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AuditError';
    this.code = code;
    this.status = STATUS[code];
    this.expose = EXPOSED.has(code);
    if (options.details !== undefined) this.details = options.details;
  }
}

export function isAuditError(value: unknown): value is AuditError {
  return value instanceof AuditError;
}
