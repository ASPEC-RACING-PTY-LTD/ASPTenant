export const ORGS_ERROR_CODES = [
  'ORGS_CONFIG_INVALID',
  'ORGS_VALIDATION_FAILED',
  'ORGS_NOT_FOUND',
  'ORGS_SLUG_TAKEN',
  'ORGS_ID_TAKEN',
  'ORGS_VERSION_CONFLICT',
  'ORGS_INVALID_STATE',
  'ORGS_MEMBER_NOT_FOUND',
  'ORGS_MEMBER_EXISTS',
  'ORGS_LAST_OWNER',
  'ORGS_TEAM_NOT_FOUND',
  'ORGS_TEAM_EXISTS',
  'ORGS_NOT_ORG_MEMBER',
  'ORGS_INVITATION_NOT_FOUND',
  'ORGS_INVITATION_EXISTS',
  'ORGS_INVITATION_EXPIRED',
  'ORGS_INVITATION_REVOKED',
  'ORGS_INVITATION_THROTTLED',
  'ORGS_TOKEN_INVALID',
  'ORGS_TOKEN_EXPIRED',
  'ORGS_EMAIL_MISMATCH',
  'ORGS_TENANT_REQUIRED',
  'ORGS_TENANT_FORBIDDEN',
  'ORGS_TENANT_EXISTS',
  'ORGS_FORBIDDEN',
  'ORGS_UNAUTHENTICATED',
  'ORGS_ROUTE_NOT_FOUND',
  'ORGS_PAYLOAD_TOO_LARGE',
  'ORGS_STORE_LIMIT',
  'ORGS_INVALID_CURSOR',
] as const;

export type OrgsErrorCode = (typeof ORGS_ERROR_CODES)[number];

const DEFAULT_STATUS: Record<OrgsErrorCode, number> = {
  ORGS_CONFIG_INVALID: 500,
  ORGS_VALIDATION_FAILED: 400,
  ORGS_NOT_FOUND: 404,
  ORGS_SLUG_TAKEN: 409,
  ORGS_ID_TAKEN: 409,
  ORGS_VERSION_CONFLICT: 409,
  ORGS_INVALID_STATE: 409,
  ORGS_MEMBER_NOT_FOUND: 404,
  ORGS_MEMBER_EXISTS: 409,
  ORGS_LAST_OWNER: 409,
  ORGS_TEAM_NOT_FOUND: 404,
  ORGS_TEAM_EXISTS: 409,
  ORGS_NOT_ORG_MEMBER: 403,
  ORGS_INVITATION_NOT_FOUND: 404,
  ORGS_INVITATION_EXISTS: 409,
  ORGS_INVITATION_EXPIRED: 410,
  ORGS_INVITATION_REVOKED: 410,
  ORGS_INVITATION_THROTTLED: 429,
  ORGS_TOKEN_INVALID: 400,
  ORGS_TOKEN_EXPIRED: 410,
  ORGS_EMAIL_MISMATCH: 403,
  ORGS_TENANT_REQUIRED: 400,
  ORGS_TENANT_FORBIDDEN: 403,
  ORGS_TENANT_EXISTS: 409,
  ORGS_FORBIDDEN: 403,
  ORGS_UNAUTHENTICATED: 401,
  ORGS_ROUTE_NOT_FOUND: 404,
  ORGS_PAYLOAD_TOO_LARGE: 413,
  ORGS_STORE_LIMIT: 507,
  ORGS_INVALID_CURSOR: 400,
};

export interface OrgsErrorOptions {
  status?: number;
  expose?: boolean;
  details?: unknown;
  cause?: unknown;
}

/** Error thrown by every @aspec/orgs API. Satisfies the ErrorLike port. */
export class OrgsError extends Error {
  readonly code: OrgsErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details: unknown;

  constructor(code: OrgsErrorCode, message: string, options: OrgsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OrgsError';
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.expose = options.expose ?? this.status < 500;
    this.details = options.details;
  }
}

export function isOrgsError(value: unknown): value is OrgsError {
  return value instanceof OrgsError;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validationError(issues: ValidationIssue[], message?: string): OrgsError {
  return new OrgsError(
    'ORGS_VALIDATION_FAILED',
    message ?? issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '),
    { details: { issues } },
  );
}
