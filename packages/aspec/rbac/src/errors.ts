/** Every error code thrown by @aspec/rbac. */
export type RbacErrorCode =
  | 'RBAC_FORBIDDEN'
  | 'RBAC_UNAUTHENTICATED'
  | 'RBAC_ROLE_NOT_FOUND'
  | 'RBAC_PERMISSION_NOT_FOUND'
  | 'RBAC_ASSIGNMENT_NOT_FOUND'
  | 'RBAC_GRANT_NOT_FOUND'
  | 'RBAC_POLICY_NOT_FOUND'
  | 'RBAC_OWNERSHIP_RULE_NOT_FOUND'
  | 'RBAC_ROUTE_NOT_FOUND'
  | 'RBAC_CYCLE_DETECTED'
  | 'RBAC_INVALID_PERMISSION'
  | 'RBAC_UNKNOWN_PERMISSION'
  | 'RBAC_INVALID_POLICY'
  | 'RBAC_INVALID_SUBJECT'
  | 'RBAC_INVALID_SNAPSHOT'
  | 'RBAC_VALIDATION'
  | 'RBAC_CONFLICT'
  | 'RBAC_ROLE_IN_USE'
  | 'RBAC_PERMISSION_IN_USE'
  | 'RBAC_SYSTEM_IMMUTABLE'
  | 'RBAC_ESCALATION'
  | 'RBAC_LIMIT_EXCEEDED'
  | 'RBAC_PAYLOAD_TOO_LARGE'
  | 'RBAC_UNSUPPORTED_MEDIA_TYPE'
  | 'RBAC_CONFIG'
  | 'RBAC_PROVIDER_MISSING';

/** One problem found while validating input. `path` is a dotted path into the input. */
export interface RbacValidationIssue {
  path: string;
  message: string;
}

export interface RbacErrorOptions {
  status?: number;
  expose?: boolean;
  details?: unknown;
  cause?: unknown;
}

/**
 * Base class of every error thrown by the module. The structural shape
 * (`code`, `status`, `expose`, `details`) satisfies the ErrorLike port.
 */
export class RbacError extends Error {
  readonly code: RbacErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details: unknown;

  constructor(code: RbacErrorCode, message: string, options: RbacErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RbacError';
    this.code = code;
    this.status = options.status ?? 500;
    this.expose = options.expose ?? this.status < 500;
    this.details = options.details;
  }
}

/** The subject is authenticated but not allowed to perform the action. */
export class RbacForbiddenError extends RbacError {
  readonly permission: string | undefined;
  constructor(message = 'Forbidden', permission?: string) {
    super('RBAC_FORBIDDEN', message, { status: 403, expose: true });
    this.name = 'RbacForbiddenError';
    this.permission = permission;
  }
}

/** No subject could be resolved for the request. */
export class RbacUnauthenticatedError extends RbacError {
  constructor(message = 'Authentication required') {
    super('RBAC_UNAUTHENTICATED', message, { status: 401, expose: true });
    this.name = 'RbacUnauthenticatedError';
  }
}

export type RbacNotFoundCode =
  | 'RBAC_ROLE_NOT_FOUND'
  | 'RBAC_PERMISSION_NOT_FOUND'
  | 'RBAC_ASSIGNMENT_NOT_FOUND'
  | 'RBAC_GRANT_NOT_FOUND'
  | 'RBAC_POLICY_NOT_FOUND'
  | 'RBAC_OWNERSHIP_RULE_NOT_FOUND'
  | 'RBAC_ROUTE_NOT_FOUND';

export class RbacNotFoundError extends RbacError {
  constructor(code: RbacNotFoundCode, message: string) {
    super(code, message, { status: 404, expose: true });
    this.name = 'RbacNotFoundError';
  }
}

export class RbacRoleNotFoundError extends RbacNotFoundError {
  readonly role: string;
  constructor(role: string) {
    super('RBAC_ROLE_NOT_FOUND', `Role "${role}" does not exist`);
    this.name = 'RbacRoleNotFoundError';
    this.role = role;
  }
}

/** A role hierarchy change would introduce a cycle. `details.cycle` lists the role keys. */
export class RbacCycleDetectedError extends RbacError {
  readonly cycle: readonly string[];
  constructor(cycle: readonly string[]) {
    super('RBAC_CYCLE_DETECTED', `Role hierarchy cycle detected: ${cycle.join(' -> ')}`, {
      status: 409,
      expose: true,
      details: { cycle },
    });
    this.name = 'RbacCycleDetectedError';
    this.cycle = cycle;
  }
}

export class RbacInvalidPermissionError extends RbacError {
  constructor(message: string, details?: unknown) {
    super('RBAC_INVALID_PERMISSION', message, { status: 400, expose: true, details });
    this.name = 'RbacInvalidPermissionError';
  }
}

export class RbacInvalidPolicyError extends RbacError {
  constructor(message: string, issues: readonly RbacValidationIssue[] = []) {
    super('RBAC_INVALID_POLICY', message, { status: 400, expose: true, details: { issues } });
    this.name = 'RbacInvalidPolicyError';
  }
}

export class RbacValidationError extends RbacError {
  readonly issues: readonly RbacValidationIssue[];
  constructor(
    message: string,
    issues: readonly RbacValidationIssue[] = [],
    code:
      | 'RBAC_VALIDATION'
      | 'RBAC_UNKNOWN_PERMISSION'
      | 'RBAC_INVALID_SUBJECT' = 'RBAC_VALIDATION',
  ) {
    super(code, message, { status: 400, expose: true, details: { issues } });
    this.name = 'RbacValidationError';
    this.issues = issues;
  }
}

export class RbacConflictError extends RbacError {
  constructor(message: string, details?: unknown) {
    super('RBAC_CONFLICT', message, { status: 409, expose: true, details });
    this.name = 'RbacConflictError';
  }
}

/** A role or permission is still referenced and `force` was not set. */
export class RbacInUseError extends RbacError {
  constructor(
    code: 'RBAC_ROLE_IN_USE' | 'RBAC_PERMISSION_IN_USE',
    message: string,
    details?: unknown,
  ) {
    super(code, message, { status: 409, expose: true, details });
    this.name = 'RbacInUseError';
  }
}

/** System entries (defined in code or configuration) cannot be changed through the admin API. */
export class RbacImmutableError extends RbacError {
  constructor(message: string) {
    super('RBAC_SYSTEM_IMMUTABLE', message, { status: 409, expose: true });
    this.name = 'RbacImmutableError';
  }
}

/** The actor tried to hand out a permission they do not hold themselves. */
export class RbacEscalationError extends RbacError {
  constructor(permission: string) {
    super('RBAC_ESCALATION', `You cannot grant "${permission}" because you do not hold it`, {
      status: 403,
      expose: true,
      details: { permission },
    });
    this.name = 'RbacEscalationError';
  }
}

export class RbacLimitError extends RbacError {
  constructor(message: string) {
    super('RBAC_LIMIT_EXCEEDED', message, { status: 409, expose: true });
    this.name = 'RbacLimitError';
  }
}

/** Invalid module configuration. Thrown at construction or startup; never exposed to clients. */
export class RbacConfigError extends RbacError {
  readonly issues: readonly RbacValidationIssue[];
  constructor(message: string, issues: readonly RbacValidationIssue[] = []) {
    super('RBAC_CONFIG', message, { status: 500, expose: false, details: { issues } });
    this.name = 'RbacConfigError';
    this.issues = issues;
  }
}

export function isRbacError(value: unknown): value is RbacError {
  return value instanceof RbacError;
}
