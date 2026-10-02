export const USERS_ERROR_CODES = [
  'USERS_CONFIG_INVALID',
  'USERS_VALIDATION_FAILED',
  'USERS_NOT_FOUND',
  'USERS_EMAIL_TAKEN',
  'USERS_ID_TAKEN',
  'USERS_EXTERNAL_ID_TAKEN',
  'USERS_VERSION_CONFLICT',
  'USERS_INVALID_STATE',
  'USERS_SUSPENDED',
  'USERS_TOKEN_INVALID',
  'USERS_TOKEN_EXPIRED',
  'USERS_INVITATION_NOT_FOUND',
  'USERS_INVITATION_EXISTS',
  'USERS_INVITATION_EXPIRED',
  'USERS_INVITATION_REVOKED',
  'USERS_INVITATION_THROTTLED',
  'USERS_ALREADY_ACTIVE',
  'USERS_INVALID_CURSOR',
  'USERS_UNAUTHENTICATED',
  'USERS_FORBIDDEN',
  'USERS_ROUTE_NOT_FOUND',
  'USERS_PAYLOAD_TOO_LARGE',
  'USERS_STORE_LIMIT',
  'USERS_HOOK_FAILED',
] as const;

export type UsersErrorCode = (typeof USERS_ERROR_CODES)[number];

const DEFAULT_STATUS: Record<UsersErrorCode, number> = {
  USERS_CONFIG_INVALID: 500,
  USERS_VALIDATION_FAILED: 400,
  USERS_NOT_FOUND: 404,
  USERS_EMAIL_TAKEN: 409,
  USERS_ID_TAKEN: 409,
  USERS_EXTERNAL_ID_TAKEN: 409,
  USERS_VERSION_CONFLICT: 409,
  USERS_INVALID_STATE: 409,
  USERS_SUSPENDED: 403,
  USERS_TOKEN_INVALID: 400,
  USERS_TOKEN_EXPIRED: 410,
  USERS_INVITATION_NOT_FOUND: 404,
  USERS_INVITATION_EXISTS: 409,
  USERS_INVITATION_EXPIRED: 410,
  USERS_INVITATION_REVOKED: 410,
  USERS_INVITATION_THROTTLED: 429,
  USERS_ALREADY_ACTIVE: 409,
  USERS_INVALID_CURSOR: 400,
  USERS_UNAUTHENTICATED: 401,
  USERS_FORBIDDEN: 403,
  USERS_ROUTE_NOT_FOUND: 404,
  USERS_PAYLOAD_TOO_LARGE: 413,
  USERS_STORE_LIMIT: 507,
  USERS_HOOK_FAILED: 500,
};

export interface UsersErrorOptions {
  status?: number;
  expose?: boolean;
  details?: unknown;
  cause?: unknown;
}

/** Error thrown by every @aspec/users API. Satisfies the ErrorLike port. */
export class UsersError extends Error {
  readonly code: UsersErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details: unknown;

  constructor(code: UsersErrorCode, message: string, options: UsersErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UsersError';
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.expose = options.expose ?? this.status < 500;
    this.details = options.details;
  }
}

export function isUsersError(value: unknown): value is UsersError {
  return value instanceof UsersError;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validationError(issues: ValidationIssue[], message?: string): UsersError {
  return new UsersError(
    'USERS_VALIDATION_FAILED',
    message ?? issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '),
    { details: { issues } },
  );
}
