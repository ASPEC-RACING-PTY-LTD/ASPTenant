import { RbacInvalidPermissionError } from './errors.js';

/**
 * Permission strings have the form `resource:action`.
 *
 * - Each segment is `*` or matches `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}` (case sensitive).
 * - `*` on its own is shorthand for `*:*` and is normalised to it.
 * - Held patterns cover requested permissions segment by segment: a held `*` segment matches
 *   any requested segment, a concrete held segment matches only the same segment. A requested
 *   wildcard (`posts:*`) is covered only by a held pattern at least as broad (`posts:*`, `*:*`).
 * - Deny patterns use overlap instead of cover: `posts:delete` denied means a request for
 *   `posts:*` (all post actions) is denied too, because the subject does not hold all of them.
 */

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MAX_PERMISSION_LENGTH = 129;

export interface ParsedPermission {
  /** Canonical form, for example `posts:update` or `*:*`. */
  readonly key: string;
  readonly resource: string;
  readonly action: string;
  readonly wildcard: boolean;
}

const parseCache = new Map<string, ParsedPermission>();
const PARSE_CACHE_LIMIT = 10_000;

function parseInternal(input: string): ParsedPermission | string {
  if (input.length === 0 || input.length > MAX_PERMISSION_LENGTH) {
    return `must be between 1 and ${MAX_PERMISSION_LENGTH} characters`;
  }
  if (input === '*') return { key: '*:*', resource: '*', action: '*', wildcard: true };
  const idx = input.indexOf(':');
  if (idx < 0 || input.indexOf(':', idx + 1) >= 0) {
    return 'must have the form resource:action';
  }
  const resource = input.slice(0, idx);
  const action = input.slice(idx + 1);
  if (resource !== '*' && !SEGMENT.test(resource)) return `invalid resource segment "${resource}"`;
  if (action !== '*' && !SEGMENT.test(action)) return `invalid action segment "${action}"`;
  return {
    key: `${resource}:${action}`,
    resource,
    action,
    wildcard: resource === '*' || action === '*',
  };
}

/** Parses and validates a permission or pattern. Throws RbacInvalidPermissionError. */
export function parsePermission(input: unknown): ParsedPermission {
  if (typeof input !== 'string') {
    throw new RbacInvalidPermissionError('Permission must be a string');
  }
  const cached = parseCache.get(input);
  if (cached) return cached;
  const parsed = parseInternal(input);
  if (typeof parsed === 'string') {
    throw new RbacInvalidPermissionError(`Invalid permission "${truncate(input)}": ${parsed}`, {
      permission: truncate(input),
    });
  }
  if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.clear();
  parseCache.set(input, parsed);
  return parsed;
}

/** Returns the validation problem for a permission, or undefined when it is valid. */
export function permissionProblem(input: unknown): string | undefined {
  if (typeof input !== 'string') return 'must be a string';
  const parsed = parseInternal(input);
  return typeof parsed === 'string' ? parsed : undefined;
}

export function isValidPermission(input: unknown): input is string {
  return permissionProblem(input) === undefined;
}

/** Validates a permission and returns its canonical form (`*` becomes `*:*`). */
export function normalisePermission(input: unknown): string {
  return parsePermission(input).key;
}

/** True when the permission contains a wildcard segment. */
export function isWildcardPermission(input: string): boolean {
  return parsePermission(input).wildcard;
}

/** True when the held pattern covers the requested permission (see module docs). */
export function permissionCovers(held: string, requested: string): boolean {
  const h = parsePermission(held);
  const r = parsePermission(requested);
  return segmentCovers(h.resource, r.resource) && segmentCovers(h.action, r.action);
}

/** True when two patterns share at least one concrete permission. */
export function permissionsOverlap(a: string, b: string): boolean {
  const x = parsePermission(a);
  const y = parsePermission(b);
  return segmentOverlaps(x.resource, y.resource) && segmentOverlaps(x.action, y.action);
}

function segmentCovers(held: string, requested: string): boolean {
  return held === '*' || held === requested;
}

function segmentOverlaps(a: string, b: string): boolean {
  return a === '*' || b === '*' || a === b;
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

/**
 * A compiled, immutable set of permission patterns with O(1) cover checks and
 * near O(1) overlap checks.
 */
export interface PermissionSet {
  readonly size: number;
  /** True when some pattern in the set covers the requested permission. */
  covers(permission: ParsedPermission | string): boolean;
  /** True when some pattern in the set overlaps the permission. */
  overlaps(permission: ParsedPermission | string): boolean;
  /** Patterns in the set that cover the permission (for explanations). */
  coveringPatterns(permission: ParsedPermission | string): string[];
  /** Patterns in the set that overlap the permission (for explanations). */
  overlappingPatterns(permission: ParsedPermission | string): string[];
  /** Canonical patterns, sorted. */
  patterns(): string[];
}

const EMPTY_PATTERNS: readonly string[] = [];

export function createPermissionSet(patterns: Iterable<string>): PermissionSet {
  let all = false;
  const exact = new Set<string>();
  const resourceWild = new Set<string>();
  const actionWild = new Set<string>();
  const exactResources = new Map<string, number>();
  const exactActions = new Map<string, number>();
  const seen = new Set<string>();
  for (const raw of patterns) {
    const p = parsePermission(raw);
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    if (p.resource === '*' && p.action === '*') all = true;
    else if (p.action === '*') resourceWild.add(p.resource);
    else if (p.resource === '*') actionWild.add(p.action);
    else {
      exact.add(p.key);
      exactResources.set(p.resource, (exactResources.get(p.resource) ?? 0) + 1);
      exactActions.set(p.action, (exactActions.get(p.action) ?? 0) + 1);
    }
  }
  const list = [...seen].sort();
  const size = list.length;

  const toParsed = (permission: ParsedPermission | string): ParsedPermission =>
    typeof permission === 'string' ? parsePermission(permission) : permission;

  const covers = (permission: ParsedPermission | string): boolean => {
    if (size === 0) return false;
    if (all) return true;
    const p = toParsed(permission);
    if (p.resource === '*') return p.action !== '*' && actionWild.has(p.action);
    if (p.action === '*') return resourceWild.has(p.resource);
    return exact.has(p.key) || resourceWild.has(p.resource) || actionWild.has(p.action);
  };

  const overlaps = (permission: ParsedPermission | string): boolean => {
    if (size === 0) return false;
    if (all) return true;
    const p = toParsed(permission);
    if (p.resource === '*' && p.action === '*') return true;
    if (p.resource === '*') {
      return actionWild.has(p.action) || exactActions.has(p.action) || resourceWild.size > 0;
    }
    if (p.action === '*') {
      return resourceWild.has(p.resource) || exactResources.has(p.resource) || actionWild.size > 0;
    }
    return exact.has(p.key) || resourceWild.has(p.resource) || actionWild.has(p.action);
  };

  return {
    size,
    covers,
    overlaps,
    coveringPatterns(permission) {
      if (size === 0) return [];
      const p = toParsed(permission);
      return list.filter((h) => permissionCovers(h, p.key));
    },
    overlappingPatterns(permission) {
      if (size === 0) return [];
      const p = toParsed(permission);
      return list.filter((h) => permissionsOverlap(h, p.key));
    },
    patterns: () => (size === 0 ? [...EMPTY_PATTERNS] : [...list]),
  };
}

export const EMPTY_PERMISSION_SET: PermissionSet = createPermissionSet([]);
