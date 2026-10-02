import { formatValue } from './diff.js';
import { invalidOption, TestingAssertionError } from './errors.js';
import type { PermissionChecker, ResourceRef, Subject } from './ports.js';

/** Matches subjects. All given fields must match; `roles` matches when the subject has any of them. */
export interface SubjectMatcher {
  id?: string | readonly string[];
  type?: string | readonly string[];
  roles?: readonly string[];
  orgId?: string;
  teamId?: string;
}

/**
 * Matches resources. All given fields must match. `ownerId: '$subject'` requires the resource
 * owner to be the subject; `orgId: '$subject'` and `teamId: '$subject'` compare against the
 * subject's orgId and teamIds. `type: '*'` matches any type.
 */
export interface ResourceMatcher {
  type?: string | readonly string[];
  id?: string | readonly string[];
  ownerId?: string;
  orgId?: string;
  teamId?: string;
  attributes?: Record<string, unknown>;
}

export interface PermissionRule {
  /** Permission pattern(s). `*` matches everything; a trailing `*` matches any suffix. */
  permission: string | readonly string[];
  subject?: SubjectMatcher | ((subject: Subject) => boolean);
  /** Omit to match any resource (including none). `null` matches only checks without a resource. */
  resource?:
    | ResourceMatcher
    | null
    | ((resource: ResourceRef | undefined, subject: Subject) => boolean);
  /** Optional label shown in recorded checks and failure messages. */
  name?: string;
}

export interface MockPermissionCheckerOptions {
  allow?: readonly PermissionRule[];
  /** Deny rules always win over allow rules. */
  deny?: readonly PermissionRule[];
  /** Decision when no rule matches (default false: deny). */
  defaultDecision?: boolean;
  /** Recorded checks are capped (oldest dropped). Default 10000. */
  maxRecordedChecks?: number;
}

export interface RecordedCheck {
  subject: Subject;
  permission: string;
  resource: ResourceRef | undefined;
  allowed: boolean;
  /** How the decision was reached. */
  reason: 'allow-rule' | 'deny-rule' | 'default';
  rule?: PermissionRule;
}

export interface MockPermissionChecker extends PermissionChecker {
  readonly checks: readonly RecordedCheck[];
  allow(rule: PermissionRule): this;
  deny(rule: PermissionRule): this;
  /** Clears recorded checks (rules are kept). */
  clearChecks(): void;
  /** Removes all rules and recorded checks. */
  reset(): void;
  /** Recorded checks matching the filter. */
  checksFor(filter: {
    permission?: string;
    subjectId?: string;
    resourceType?: string;
  }): RecordedCheck[];
  /** Throws unless at least one matching check was recorded. */
  expectChecked(
    permission: string,
    filter?: { subjectId?: string; resourceType?: string; allowed?: boolean },
  ): void;
}

const patternCache = new Map<string, RegExp>();

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles a permission pattern. `*` alone matches all; a trailing `*` matches any suffix; an inner `*` matches one segment. */
export function permissionPatternToRegExp(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (re) return re;
  if (pattern.length === 0 || pattern.length > 200)
    throw invalidOption('permission', 'patterns must be 1 to 200 characters');
  const parts = pattern.split('*');
  const body = parts
    .map((part, i) => {
      const escaped = escapeRegExp(part);
      if (i === parts.length - 1) return escaped;
      return i === parts.length - 2 && parts[parts.length - 1] === ''
        ? `${escaped}.+`
        : `${escaped}[^:./]+`;
    })
    .join('');
  re = new RegExp(`^${body}$`);
  if (patternCache.size > 1000) patternCache.clear();
  patternCache.set(pattern, re);
  return re;
}

export function permissionMatches(pattern: string, permission: string): boolean {
  return permissionPatternToRegExp(pattern).test(permission);
}

function oneOf(
  expected: string | readonly string[] | undefined,
  actual: string | undefined,
): boolean {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  return typeof expected === 'string'
    ? expected === actual || expected === '*'
    : expected.includes(actual);
}

function subjectMatches(matcher: PermissionRule['subject'], subject: Subject): boolean {
  if (matcher === undefined) return true;
  if (typeof matcher === 'function') return matcher(subject);
  if (!oneOf(matcher.id, subject.id)) return false;
  if (!oneOf(matcher.type, subject.type)) return false;
  if (matcher.roles && !matcher.roles.some((r) => subject.roles?.includes(r))) return false;
  if (matcher.orgId !== undefined && matcher.orgId !== subject.orgId) return false;
  if (matcher.teamId !== undefined && !subject.teamIds?.includes(matcher.teamId)) return false;
  return true;
}

function resourceMatches(
  matcher: PermissionRule['resource'],
  resource: ResourceRef | undefined,
  subject: Subject,
): boolean {
  if (matcher === undefined) return true;
  if (matcher === null) return resource === undefined;
  if (typeof matcher === 'function') return matcher(resource, subject);
  if (resource === undefined) return false;
  if (!oneOf(matcher.type, resource.type)) return false;
  if (!oneOf(matcher.id, resource.id)) return false;
  if (matcher.ownerId !== undefined) {
    const want = matcher.ownerId === '$subject' ? subject.id : matcher.ownerId;
    if (resource.ownerId !== want) return false;
  }
  if (matcher.orgId !== undefined) {
    const want = matcher.orgId === '$subject' ? subject.orgId : matcher.orgId;
    if (want === undefined || resource.orgId !== want) return false;
  }
  if (matcher.teamId !== undefined) {
    if (matcher.teamId === '$subject') {
      if (resource.teamId === undefined || !subject.teamIds?.includes(resource.teamId))
        return false;
    } else if (resource.teamId !== matcher.teamId) return false;
  }
  if (matcher.attributes) {
    for (const [k, v] of Object.entries(matcher.attributes)) {
      if (!Object.is(resource.attributes?.[k], v)) return false;
    }
  }
  return true;
}

function ruleMatches(
  rule: PermissionRule,
  subject: Subject,
  permission: string,
  resource: ResourceRef | undefined,
): boolean {
  const patterns = typeof rule.permission === 'string' ? [rule.permission] : rule.permission;
  if (!patterns.some((p) => permissionMatches(p, permission))) return false;
  return subjectMatches(rule.subject, subject) && resourceMatches(rule.resource, resource, subject);
}

function validateRule(rule: PermissionRule, option: string): void {
  const patterns = typeof rule.permission === 'string' ? [rule.permission] : rule.permission;
  if (patterns.length === 0) throw invalidOption(option, 'permission must not be empty');
  for (const p of patterns) permissionPatternToRegExp(p);
}

/** A PermissionChecker driven by allow and deny rules that records every check. */
export function createMockPermissionChecker(
  options: MockPermissionCheckerOptions = {},
): MockPermissionChecker {
  const allowRules: PermissionRule[] = [];
  const denyRules: PermissionRule[] = [];
  const checks: RecordedCheck[] = [];
  const max = options.maxRecordedChecks ?? 10_000;
  for (const r of options.allow ?? []) {
    validateRule(r, 'allow');
    allowRules.push(r);
  }
  for (const r of options.deny ?? []) {
    validateRule(r, 'deny');
    denyRules.push(r);
  }

  const checker: MockPermissionChecker = {
    checks,
    async can(subject, permission, resource) {
      let record: RecordedCheck;
      const denyRule = denyRules.find((r) => ruleMatches(r, subject, permission, resource));
      if (denyRule) {
        record = {
          subject,
          permission,
          resource,
          allowed: false,
          reason: 'deny-rule',
          rule: denyRule,
        };
      } else {
        const allowRule = allowRules.find((r) => ruleMatches(r, subject, permission, resource));
        record = allowRule
          ? { subject, permission, resource, allowed: true, reason: 'allow-rule', rule: allowRule }
          : {
              subject,
              permission,
              resource,
              allowed: options.defaultDecision ?? false,
              reason: 'default',
            };
      }
      checks.push(record);
      if (checks.length > max) checks.splice(0, checks.length - max);
      return record.allowed;
    },
    allow(rule) {
      validateRule(rule, 'allow');
      allowRules.push(rule);
      return this;
    },
    deny(rule) {
      validateRule(rule, 'deny');
      denyRules.push(rule);
      return this;
    },
    clearChecks() {
      checks.length = 0;
    },
    reset() {
      allowRules.length = 0;
      denyRules.length = 0;
      checks.length = 0;
    },
    checksFor(filter) {
      return checks.filter(
        (c) =>
          (filter.permission === undefined || c.permission === filter.permission) &&
          (filter.subjectId === undefined || c.subject.id === filter.subjectId) &&
          (filter.resourceType === undefined || c.resource?.type === filter.resourceType),
      );
    },
    expectChecked(permission, filter = {}) {
      const found = checker
        .checksFor({ permission, ...filter })
        .filter((c) => filter.allowed === undefined || c.allowed === filter.allowed);
      if (found.length > 0) return;
      const seen = checks.map(
        (c) =>
          `  ${c.permission} by ${c.subject.id}${c.resource ? ` on ${c.resource.type}${c.resource.id ? `:${c.resource.id}` : ''}` : ''} -> ${c.allowed ? 'allowed' : 'denied'}`,
      );
      throw new TestingAssertionError(
        `Expected a permission check for "${permission}"${filter.subjectId ? ` by ${filter.subjectId}` : ''}${filter.resourceType ? ` on ${filter.resourceType}` : ''}${filter.allowed === undefined ? '' : ` (${filter.allowed ? 'allowed' : 'denied'})`}.\nRecorded checks:\n${seen.join('\n') || '  (none)'}`,
      );
    },
  };
  return checker;
}

function describeCheck(
  subject: Subject,
  permission: string,
  resource: ResourceRef | undefined,
): string {
  return `subject ${formatValue(subject, 300)} permission "${permission}"${resource ? ` resource ${formatValue(resource, 300)}` : ' (no resource)'}`;
}

/** Asserts that any PermissionChecker (mock or real, such as @aspec/rbac) allows the check. */
export async function expectAllowed(
  checker: PermissionChecker,
  subject: Subject,
  permission: string,
  resource?: ResourceRef,
): Promise<void> {
  const allowed = await checker.can(subject, permission, resource);
  if (!allowed) {
    throw new TestingAssertionError(
      `Expected to be allowed but was denied: ${describeCheck(subject, permission, resource)}`,
      false,
      true,
    );
  }
}

/** Asserts that any PermissionChecker denies the check. */
export async function expectDenied(
  checker: PermissionChecker,
  subject: Subject,
  permission: string,
  resource?: ResourceRef,
): Promise<void> {
  const allowed = await checker.can(subject, permission, resource);
  if (allowed) {
    throw new TestingAssertionError(
      `Expected to be denied but was allowed: ${describeCheck(subject, permission, resource)}`,
      true,
      false,
    );
  }
}

export interface PolicyCase {
  subject: Subject;
  permission: string;
  resource?: ResourceRef;
  allowed: boolean;
  /** Optional label used in the failure report. */
  name?: string;
}

/** Evaluates a policy table and reports every mismatching case at once. */
export async function expectPolicy(
  checker: PermissionChecker,
  cases: readonly PolicyCase[],
): Promise<void> {
  const failures: string[] = [];
  const actual: boolean[] = [];
  for (const [i, c] of cases.entries()) {
    const allowed = await checker.can(c.subject, c.permission, c.resource);
    actual.push(allowed);
    if (allowed !== c.allowed) {
      failures.push(
        `  #${i}${c.name ? ` ${c.name}` : ''}: expected ${c.allowed ? 'allowed' : 'denied'}, got ${allowed ? 'allowed' : 'denied'}: ${describeCheck(c.subject, c.permission, c.resource)}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new TestingAssertionError(
      `${failures.length} of ${cases.length} policy case(s) failed:\n${failures.join('\n')}`,
      actual,
      cases.map((c) => c.allowed),
    );
  }
}
