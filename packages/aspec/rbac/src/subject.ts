import { RbacValidationError } from './errors.js';
import type { Subject } from './ports.js';
import { Issues, isIdentifier, isRecord, readIdentifier } from './validate.js';

/** Resolves an authenticated subject from a framework request. Return null when anonymous. */
export type SubjectResolver<TReq> = (
  request: TReq,
) => Subject | null | undefined | Promise<Subject | null | undefined>;

export interface ClaimsMapping {
  /** Claim holding the subject id. Default `sub`. */
  id?: string;
  /** Claim holding roles. Default `roles`. */
  roles?: string;
  /** Claim holding the organisation id. Default `org_id`. */
  orgId?: string;
  /** Claim holding team ids. Default `team_ids`. */
  teamIds?: string;
  /** Claim holding subject type. Default `type`. */
  type?: string;
  /** Extra claim names copied into `attributes`. */
  attributes?: readonly string[];
}

export interface UserMapping {
  /** Property holding the user id. Default `id`. */
  id?: string;
  /** Property holding roles. Default `roles`. */
  roles?: string;
  /** Property holding the organisation id. Default `orgId`. */
  orgId?: string;
  /** Property holding team ids. Default `teamIds`. */
  teamIds?: string;
  /** Property holding subject type. Default `type`. */
  type?: string;
  /** Extra property names copied into `attributes`. */
  attributes?: readonly string[];
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.length > 0 ? [value] : undefined;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && !out.includes(item)) out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Builds a Subject from JWT-style claims (or any plain object of claims).
 *
 * Default mapping: `sub`, `roles`, `org_id`, `team_ids`, `type`.
 *
 * @example
 * ```ts
 * const subject = subjectFromClaims(jwt.payload);
 * // Passport / session user:
 * const subject = subjectFromUser(req.user);
 * // @aspec/auth: map the authenticated user through subjectFromUser or a custom resolver.
 * ```
 */
export function subjectFromClaims(claims: unknown, mapping: ClaimsMapping = {}): Subject {
  if (!isRecord(claims)) {
    throw new RbacValidationError(
      'Claims must be an object',
      [{ path: 'claims', message: 'must be an object' }],
      'RBAC_INVALID_SUBJECT',
    );
  }
  const idKey = mapping.id ?? 'sub';
  const rolesKey = mapping.roles ?? 'roles';
  const orgKey = mapping.orgId ?? 'org_id';
  const teamsKey = mapping.teamIds ?? 'team_ids';
  const typeKey = mapping.type ?? 'type';

  const issues = new Issues();
  const id = readIdentifier(claims[idKey], idKey, issues, true);
  if (!id) {
    throw new RbacValidationError(
      'Invalid subject claims',
      issues.list.length > 0 ? issues.list : [{ path: idKey, message: 'is required' }],
      'RBAC_INVALID_SUBJECT',
    );
  }

  const subject: Subject = { id };
  const roles = asStringArray(claims[rolesKey]);
  if (roles) subject.roles = roles;
  const orgId = claims[orgKey];
  if (orgId !== undefined) {
    if (!isIdentifier(orgId)) {
      throw new RbacValidationError(
        'Invalid subject claims',
        [{ path: orgKey, message: 'invalid' }],
        'RBAC_INVALID_SUBJECT',
      );
    }
    subject.orgId = orgId;
  }
  const teamIds = asStringArray(claims[teamsKey]);
  if (teamIds) subject.teamIds = teamIds;
  const type = claims[typeKey];
  if (typeof type === 'string' && type.length > 0) subject.type = type;

  if (mapping.attributes && mapping.attributes.length > 0) {
    const attributes: Record<string, unknown> = {};
    for (const key of mapping.attributes) {
      if (Object.hasOwn(claims, key)) attributes[key] = claims[key];
    }
    if (Object.keys(attributes).length > 0) subject.attributes = attributes;
  }
  return subject;
}

/**
 * Builds a Subject from a Passport-style or session user object.
 *
 * Default mapping: `id`, `roles`, `orgId`, `teamIds`, `type`.
 *
 * For @aspec/auth, pass the authenticated user (or a thin wrapper) through this helper
 * or write a custom SubjectResolver that reads the auth context your app attaches to the request.
 */
export function subjectFromUser(user: unknown, mapping: UserMapping = {}): Subject {
  if (!isRecord(user)) {
    throw new RbacValidationError(
      'User must be an object',
      [{ path: 'user', message: 'must be an object' }],
      'RBAC_INVALID_SUBJECT',
    );
  }
  return subjectFromClaims(user, {
    id: mapping.id ?? 'id',
    roles: mapping.roles ?? 'roles',
    orgId: mapping.orgId ?? 'orgId',
    teamIds: mapping.teamIds ?? 'teamIds',
    type: mapping.type ?? 'type',
    ...(mapping.attributes === undefined ? {} : { attributes: mapping.attributes }),
  });
}
