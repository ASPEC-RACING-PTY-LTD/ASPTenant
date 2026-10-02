import { RbacValidationError, type RbacValidationIssue } from './errors.js';
import { permissionProblem } from './permissions.js';
import type { RbacScope, ScopeKind } from './types.js';
import { SCOPE_KINDS } from './types.js';

export const ROLE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
export const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:*-]{0,127}$/;
export const RESOURCE_TYPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MAX_ID_LENGTH = 256;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_NAME_LENGTH = 120;

/** Collects issues and throws a single RbacValidationError. */
export class Issues {
  readonly list: RbacValidationIssue[] = [];
  add(path: string, message: string): void {
    if (this.list.length < 50) this.list.push({ path, message });
  }
  get empty(): boolean {
    return this.list.length === 0;
  }
  throwIfAny(message = 'Invalid input'): void {
    if (this.list.length > 0) throw new RbacValidationError(message, this.list);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkUnknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: Issues,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) issues.add(path ? `${path}.${key}` : key, 'unknown property');
  }
}

/** A trimmed-free identifier string (ids from external systems: subjects, orgs, resources). */
export function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function readIdentifier(
  value: unknown,
  path: string,
  issues: Issues,
  required: boolean,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) issues.add(path, 'is required');
    return undefined;
  }
  if (!isIdentifier(value)) {
    issues.add(path, `must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
    return undefined;
  }
  return value;
}

export function readPattern(
  value: unknown,
  pattern: RegExp,
  path: string,
  issues: Issues,
  required: boolean,
  label: string,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) issues.add(path, 'is required');
    return undefined;
  }
  if (typeof value !== 'string' || !pattern.test(value)) {
    issues.add(path, `must be a valid ${label}`);
    return undefined;
  }
  return value;
}

export function readText(
  value: unknown,
  path: string,
  issues: Issues,
  max: number,
  required = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) issues.add(path, 'is required');
    return undefined;
  }
  if (typeof value !== 'string' || (required && value.length === 0) || value.length > max) {
    issues.add(path, `must be a string of at most ${max} characters`);
    return undefined;
  }
  return value;
}

export function readPermissionList(
  value: unknown,
  path: string,
  issues: Issues,
  options: { required?: boolean; allowWildcards?: boolean; max?: number; nonEmpty?: boolean } = {},
): string[] | undefined {
  if (value === undefined || value === null) {
    if (options.required) issues.add(path, 'is required');
    return undefined;
  }
  const max = options.max ?? 1000;
  if (!Array.isArray(value) || value.length > max) {
    issues.add(path, `must be an array of at most ${max} permissions`);
    return undefined;
  }
  if (options.nonEmpty && value.length === 0) {
    issues.add(path, 'must not be empty');
    return undefined;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  let ok = true;
  value.forEach((item: unknown, index) => {
    const problem = permissionProblem(item);
    if (problem) {
      issues.add(`${path}.${index}`, `invalid permission: ${problem}`);
      ok = false;
      return;
    }
    const key = item === '*' ? '*:*' : (item as string);
    if (options.allowWildcards === false && key.includes('*')) {
      issues.add(`${path}.${index}`, 'wildcards are not allowed here');
      ok = false;
      return;
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  });
  return ok ? out : undefined;
}

export function readKeyList(
  value: unknown,
  pattern: RegExp,
  path: string,
  issues: Issues,
  label: string,
  max = 100,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > max) {
    issues.add(path, `must be an array of at most ${max} ${label}s`);
    return undefined;
  }
  const out: string[] = [];
  let ok = true;
  value.forEach((item: unknown, index) => {
    if (typeof item !== 'string' || !pattern.test(item)) {
      issues.add(`${path}.${index}`, `must be a valid ${label}`);
      ok = false;
    } else if (!out.includes(item)) {
      out.push(item);
    }
  });
  return ok ? out : undefined;
}

export function readScopeKinds(
  value: unknown,
  path: string,
  issues: Issues,
): ScopeKind[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    issues.add(path, 'must be a non-empty array of global, org or team');
    return undefined;
  }
  const out: ScopeKind[] = [];
  for (const [index, item] of value.entries()) {
    if (!(SCOPE_KINDS as readonly unknown[]).includes(item)) {
      issues.add(`${path}.${index}`, 'must be global, org or team');
      return undefined;
    }
    if (!out.includes(item as ScopeKind)) out.push(item as ScopeKind);
  }
  return out;
}

export function readTimestamp(value: unknown, path: string, issues: Issues): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && value.length <= 40) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  issues.add(path, 'must be an epoch millisecond number, ISO 8601 string or Date');
  return undefined;
}

/** Validates a scope object. `teamId` requires `orgId`. */
export function readScope(value: unknown, path: string, issues: Issues): RbacScope | undefined {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    issues.add(path, 'must be an object with optional orgId and teamId');
    return undefined;
  }
  checkUnknownKeys(value, ['orgId', 'teamId'], path, issues);
  const orgId = readIdentifier(value.orgId, `${path}.orgId`, issues, false);
  const teamId = readIdentifier(value.teamId, `${path}.teamId`, issues, false);
  if (teamId !== undefined && orgId === undefined) {
    issues.add(`${path}.teamId`, 'requires orgId');
    return undefined;
  }
  return makeScope(orgId, teamId);
}

export function makeScope(orgId: string | undefined, teamId: string | undefined): RbacScope {
  if (orgId === undefined) return {};
  if (teamId === undefined) return { orgId };
  return { orgId, teamId };
}

/** Throws RbacValidationError when the scope is invalid; returns a normalised copy. */
export function normaliseScope(value: unknown, path = 'scope'): RbacScope {
  const issues = new Issues();
  const scope = readScope(value, path, issues);
  issues.throwIfAny('Invalid scope');
  return scope ?? {};
}

export function scopeKind(scope: RbacScope): ScopeKind {
  if (scope.orgId === undefined) return 'global';
  return scope.teamId === undefined ? 'org' : 'team';
}

export function readLimit(value: unknown, path: string, issues: Issues, max = 500): number {
  if (value === undefined || value === null || value === '') return 50;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) {
    issues.add(path, `must be an integer between 1 and ${max}`);
    return 50;
  }
  return n;
}
