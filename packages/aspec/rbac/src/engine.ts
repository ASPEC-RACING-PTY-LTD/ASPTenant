import { randomInt } from 'node:crypto';
import { createAdmin, type RbacAdmin } from './admin.js';
import { type Auditor, createAuditor } from './audit.js';
import { buildCatalog, type Catalog, type CompiledPolicy, type MergedRoles } from './catalog.js';
import type { ConditionInput } from './conditions.js';
import {
  DEFAULT_ADMIN_PERMISSION,
  defineRbac,
  isValidTimeZone,
  type RbacDefinition,
  type RbacDefinitionInput,
  seedDefinition,
} from './config.js';
import {
  RbacConfigError,
  RbacConflictError,
  RbacForbiddenError,
  RbacValidationError,
} from './errors.js';
import { createUuidV7Generator } from './ids.js';
import { type ParsedPermission, parsePermission } from './permissions.js';
import type {
  AuditSink,
  CacheLike,
  Clock,
  IdGenerator,
  LoggerLike,
  PermissionChecker,
  ResourceRef,
  Subject,
} from './ports.js';
import type { PermissionSnapshot, SnapshotGrant, SnapshotResourceDecision } from './snapshot.js';
import type { RbacStore } from './store.js';
import { createMemoryStore } from './stores/memory.js';
import type { AssignmentRecord, Effect, GrantRecord, RbacScope, ScopeKind } from './types.js';
import { isIdentifier, isRecord, makeScope, normaliseScope } from './validate.js';

/** Per-check context. `scope` selects the evaluation scope; every key is visible to policies. */
export interface CheckContext {
  scope?: RbacScope;
  [key: string]: unknown;
}

export type DecisionReason = 'role' | 'grant' | 'ownership' | 'policy' | 'default';

export type TraceEntry =
  | { type: 'role'; effect: Effect; role: string; via: string; pattern: string }
  | {
      type: 'grant';
      effect: Effect;
      grantId: string;
      subjectId?: string;
      roleKey?: string;
      pattern: string;
    }
  | { type: 'ownership'; effect: 'allow'; ruleId: string; resourceType: string; pattern: string }
  | { type: 'policy'; effect: Effect; policyId: string; pattern: string };

export interface RbacDecision {
  allowed: boolean;
  permission: string;
  scope: RbacScope;
  /** What produced the result; `default` means nothing allowed it (default deny). */
  reason: DecisionReason;
  /** The rule that decided. Undefined for default deny. */
  decisive?: TraceEntry;
}

export interface AppliedRole {
  key: string;
  source: 'assignment' | 'static';
  assignmentId?: string;
  /** Scope of the assignment (global for static roles unless the subject carries an orgId). */
  scope: RbacScope;
  /** Ancestor roles inherited through this role (excluding itself). */
  inherited: string[];
}

export interface PolicyEvaluation {
  policyId: string;
  effect: Effect;
  result: boolean;
}

export interface RbacExplanation extends RbacDecision {
  subjectId: string;
  resource?: { type: string; id?: string };
  /** Roles that apply in the evaluation scope and where they came from. */
  roles: AppliedRole[];
  /** Every effective role key (assigned plus inherited), sorted. */
  effectiveRoles: string[];
  /** Role keys that are assigned but unknown, expired, out of scope or not assignable there. */
  ignoredRoles: { key: string; reason: 'unknown' | 'expired' | 'scope' | 'not-assignable' }[];
  /** Every matching allow and deny rule, denies first. */
  matches: TraceEntry[];
  /** Policies whose permission, resource type and role filters applied, with the result. */
  policies: PolicyEvaluation[];
}

export interface EffectivePermissions {
  subjectId: string;
  scope: RbacScope;
  roles: string[];
  permissions: string[];
  denies: string[];
}

export interface SnapshotOptions {
  /** Scope the snapshot represents. Default: the subject's orgId, or global. */
  scope?: RbacScope;
  /**
   * Permissions the frontend needs. When set, patterns, ownership rules and grants are
   * filtered to entries relevant to these permissions and each one is evaluated on the server
   * (including policies) into `decisions`. At most 200.
   */
  permissions?: readonly string[];
  /** Resources to precompute decisions for (requires `permissions`). At most 100. */
  resources?: readonly ResourceRef[];
  /** Maximum grants included. Default `limits.maxSnapshotGrants` (500). */
  maxGrants?: number;
  context?: CheckContext;
}

export interface BatchCheck {
  permission: string;
  resource?: ResourceRef;
  context?: CheckContext;
}

export interface RbacLimits {
  /** Maximum role assignments per subject (all scopes). Default 500. */
  maxAssignmentsPerSubject: number;
  /** Maximum catalogue roles. Default 10000. */
  maxRoles: number;
  /** Maximum permissions (allow plus deny) per role. Default 1000. */
  maxPermissionsPerRole: number;
  /** Maximum grants included in a permission snapshot. Default 500. */
  maxSnapshotGrants: number;
}

export interface RbacOptions {
  /** Persistence. Default: a new in-memory store. */
  store?: RbacStore;
  /** Code-defined permissions, roles, ownership rules and policies, seeded on init. */
  definition?: RbacDefinition | RbacDefinitionInput;
  /** Remove system entries that are no longer in the definition when seeding. Default true. */
  pruneDefinition?: boolean;
  /** Optional cache for subject assignment lookups. Failures are treated as misses. */
  cache?: CacheLike;
  /** TTL of cached subject assignments in ms. Default 60000. */
  cacheTtlMs?: number;
  /** Prefix of cache keys. Default `rbac:`. */
  cacheKeyPrefix?: string;
  /** Receives permission change events and, optionally, denied decisions. */
  audit?: AuditSink;
  /** Record `rbac.access.denied` events: false (default), true, or `{ sampleRate: 0..1 }`. */
  auditDenied?: boolean | { sampleRate: number };
  /** What to do when the audit sink throws during an admin mutation. Default `log`. */
  auditFailure?: 'log' | 'throw';
  logger?: LoggerLike;
  clock?: Clock;
  generateId?: IdGenerator;
  /** Organisation-scoped roles also apply inside that organisation's teams. Default true. */
  orgRolesApplyToTeams?: boolean;
  /**
   * How `subject.roles` (roles asserted by the authentication provider) apply:
   * `auto` (default): within `subject.orgId` when set, otherwise globally;
   * `global`: everywhere; `ignore`: never.
   */
  staticRoles?: 'auto' | 'global' | 'ignore';
  /** Reload the catalogue (roles, policies, rules) after this many ms. 0 disables. Default 30000. */
  catalogTtlMs?: number;
  /** Permission required by the admin HTTP API for mutations. Default `rbac:admin`. */
  adminPermission?: string;
  /** Permission required by the admin HTTP API for reads. Default: adminPermission. */
  adminReadPermission?: string;
  /** Admin mutations must reference registered permissions. Default true. */
  requireRegisteredPermissions?: boolean;
  /** Actors cannot hand out permissions they do not hold. Default true. */
  preventEscalation?: boolean;
  /** Time zone of `context.time` for policies. Default `UTC`. */
  timeZone?: string;
  limits?: Partial<RbacLimits>;
  /** Random source in [0, 1) for denied-decision sampling. Default: crypto.randomInt based. */
  random?: () => number;
}

/** The authorisation engine. Implements the PermissionChecker port. */
export interface Rbac extends PermissionChecker {
  /** Seeds the definition and loads the catalogue. Called implicitly by every method. */
  init(): Promise<void>;
  can(
    subject: Subject,
    permission: string,
    resource?: ResourceRef,
    context?: CheckContext,
  ): Promise<boolean>;
  /** Throws RbacForbiddenError when denied. */
  check(
    subject: Subject,
    permission: string,
    resource?: ResourceRef,
    context?: CheckContext,
  ): Promise<void>;
  canAll(
    subject: Subject,
    permissions: readonly string[],
    resource?: ResourceRef,
    context?: CheckContext,
  ): Promise<boolean>;
  canAny(
    subject: Subject,
    permissions: readonly string[],
    resource?: ResourceRef,
    context?: CheckContext,
  ): Promise<boolean>;
  /** Evaluates several checks for one subject, loading its assignments once. */
  checkMany(subject: Subject, checks: readonly BatchCheck[]): Promise<boolean[]>;
  /** Decision with the rule that produced it. */
  decide(
    subject: Subject,
    permission: string,
    resource?: ResourceRef,
    context?: CheckContext,
  ): Promise<RbacDecision>;
  /** Full decision trace (every matching rule, roles and policies considered). */
  explain(
    subject: Subject,
    permission: string,
    resource?: ResourceRef,
    context?: CheckContext,
  ): Promise<RbacExplanation>;
  /** Role-derived effective permissions in a scope (resource grants and policies excluded). */
  permissionsFor(subject: Subject, scope?: RbacScope): Promise<EffectivePermissions>;
  /** Effective role keys (assigned plus inherited) in a scope. */
  rolesFor(subject: Subject, scope?: RbacScope): Promise<string[]>;
  hasRole(subject: Subject, role: string, scope?: RbacScope): Promise<boolean>;
  createPermissionSnapshot(
    subject: Subject,
    options?: SnapshotOptions,
  ): Promise<PermissionSnapshot>;
  /** Drops the cached catalogue and, when given, a subject's cached assignments. */
  invalidate(subjectId?: string): Promise<void>;
  readonly admin: RbacAdmin;
  readonly store: RbacStore;
  readonly adminPermission: string;
  readonly adminReadPermission: string;
}

/** Internal surface shared with the admin service. */
export interface EngineInternals {
  readonly store: RbacStore;
  readonly clock: Clock;
  readonly generateId: IdGenerator;
  readonly logger: LoggerLike;
  readonly auditor: Auditor;
  readonly limits: RbacLimits;
  readonly requireRegisteredPermissions: boolean;
  readonly preventEscalation: boolean;
  readonly adminPermission: string;
  readonly adminReadPermission: string;
  ready(): Promise<void>;
  catalog(): Promise<Catalog>;
  invalidateCatalog(): void;
  invalidateSubject(subjectId: string): Promise<void>;
  bumpGeneration(): Promise<void>;
  can(
    subject: Subject,
    permission: string,
    resource?: ResourceRef,
    context?: CheckContext,
  ): Promise<boolean>;
  effectiveRolePatterns(roleKey: string): Promise<string[]>;
}

const NOOP_LOGGER: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const DEFAULT_LIMITS: RbacLimits = {
  maxAssignmentsPerSubject: 500,
  maxRoles: 10_000,
  maxPermissionsPerRole: 1000,
  maxSnapshotGrants: 500,
};

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function configIssue(path: string, message: string): never {
  throw new RbacConfigError(`Invalid RBAC option ${path}: ${message}`, [{ path, message }]);
}

function validateOptions(options: RbacOptions): void {
  const nonNegInt = (key: 'cacheTtlMs' | 'catalogTtlMs') => {
    const v = options[key];
    if (v !== undefined && (!Number.isInteger(v) || v < 0))
      configIssue(key, 'must be a non-negative integer');
  };
  nonNegInt('cacheTtlMs');
  nonNegInt('catalogTtlMs');
  for (const key of ['adminPermission', 'adminReadPermission'] as const) {
    const v = options[key];
    if (v === undefined) continue;
    try {
      if (parsePermission(v).wildcard) configIssue(key, 'must not contain wildcards');
    } catch (err) {
      if (err instanceof RbacConfigError) throw err;
      configIssue(key, 'must be a permission of the form resource:action');
    }
  }
  if (
    options.staticRoles !== undefined &&
    !['auto', 'global', 'ignore'].includes(options.staticRoles)
  ) {
    configIssue('staticRoles', 'must be auto, global or ignore');
  }
  if (options.timeZone !== undefined && !isValidTimeZone(options.timeZone)) {
    configIssue('timeZone', 'must be an IANA time zone');
  }
  const ad = options.auditDenied;
  if (
    ad !== undefined &&
    typeof ad !== 'boolean' &&
    !(isRecord(ad) && typeof ad.sampleRate === 'number' && ad.sampleRate >= 0 && ad.sampleRate <= 1)
  ) {
    configIssue('auditDenied', 'must be a boolean or { sampleRate: 0..1 }');
  }
  if (options.auditFailure !== undefined && !['log', 'throw'].includes(options.auditFailure)) {
    configIssue('auditFailure', 'must be log or throw');
  }
  if (
    options.cacheKeyPrefix !== undefined &&
    (typeof options.cacheKeyPrefix !== 'string' || options.cacheKeyPrefix.length > 64)
  ) {
    configIssue('cacheKeyPrefix', 'must be a string of at most 64 characters');
  }
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!(key in DEFAULT_LIMITS)) configIssue(`limits.${key}`, 'unknown limit');
    if (!Number.isInteger(value) || (value as number) < 1)
      configIssue(`limits.${key}`, 'must be a positive integer');
  }
}

function assertSubject(subject: unknown): asserts subject is Subject {
  if (!isRecord(subject) || !isIdentifier(subject.id)) {
    throw new RbacValidationError(
      'Subject must be an object with a non-empty string id',
      [{ path: 'subject.id', message: 'is required' }],
      'RBAC_INVALID_SUBJECT',
    );
  }
  if (subject.roles !== undefined && !Array.isArray(subject.roles)) {
    throw new RbacValidationError(
      'subject.roles must be an array',
      [{ path: 'subject.roles', message: 'must be an array' }],
      'RBAC_INVALID_SUBJECT',
    );
  }
  if (subject.orgId !== undefined && !isIdentifier(subject.orgId)) {
    throw new RbacValidationError(
      'subject.orgId must be a non-empty string',
      [{ path: 'subject.orgId', message: 'invalid' }],
      'RBAC_INVALID_SUBJECT',
    );
  }
}

function assertResource(resource: unknown): asserts resource is ResourceRef | undefined {
  if (resource === undefined) return;
  const bad = (path: string) => {
    throw new RbacValidationError('Invalid resource reference', [
      { path, message: 'must be a non-empty string' },
    ]);
  };
  if (!isRecord(resource) || !isIdentifier(resource.type)) bad('resource.type');
  const r = resource as Record<string, unknown>;
  for (const key of ['id', 'ownerId', 'orgId', 'teamId'] as const) {
    if (r[key] !== undefined && !isIdentifier(r[key])) bad(`resource.${key}`);
  }
}

/** Creates the authorisation engine. Options are validated immediately (RbacConfigError). */
export function createRbac(options: RbacOptions = {}): Rbac {
  validateOptions(options);
  const store = options.store ?? createMemoryStore();
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const logger = options.logger ?? NOOP_LOGGER;
  const generateId = options.generateId ?? createUuidV7Generator(clock);
  const definition = options.definition === undefined ? undefined : defineRbac(options.definition);
  const adminPermission = options.adminPermission ?? DEFAULT_ADMIN_PERMISSION;
  const adminReadPermission = options.adminReadPermission ?? adminPermission;
  const orgRolesApplyToTeams = options.orgRolesApplyToTeams ?? true;
  const staticRoles = options.staticRoles ?? 'auto';
  const catalogTtlMs = options.catalogTtlMs ?? 30_000;
  const cache = options.cache;
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const cachePrefix = options.cacheKeyPrefix ?? 'rbac:';
  const limits: RbacLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const auditor = createAuditor(options.audit, logger, options.auditFailure ?? 'log');
  const deniedRate =
    options.auditDenied === undefined || options.auditDenied === false
      ? 0
      : options.auditDenied === true
        ? 1
        : options.auditDenied.sampleRate;
  const random = options.random ?? (() => randomInt(0, 1_000_000) / 1_000_000);
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: options.timeZone ?? 'UTC',
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  });

  let initPromise: Promise<void> | undefined;
  let current: Catalog | undefined;
  let catalogVersion = 0;
  let loadedVersion = -1;
  let loading: Promise<Catalog> | undefined;
  let generation = 0;

  const builtInPermissions = [
    {
      key: adminPermission,
      description: 'Manage roles, permissions, assignments, grants and policies',
    },
    ...(adminReadPermission === adminPermission
      ? []
      : [
          {
            key: adminReadPermission,
            description: 'Read roles, permissions, assignments, grants and policies',
          },
        ]),
  ];

  const ready = (): Promise<void> => {
    if (!initPromise) {
      initPromise = (async () => {
        if (definition) {
          let attempt = 0;
          for (;;) {
            try {
              const result = await seedDefinition(store, definition, {
                now: clock.now(),
                builtInPermissions,
                prune: options.pruneDefinition ?? true,
                logger,
              });
              if (result.created + result.updated + result.removed + result.demoted > 0) {
                logger.info({ ...result }, 'rbac: definition seeded');
              }
              break;
            } catch (err) {
              if (err instanceof RbacConflictError && attempt < 3) {
                attempt++;
                continue;
              }
              throw err;
            }
          }
        } else {
          for (const p of builtInPermissions) {
            const existing = await store.getPermission(p.key);
            if (!existing) {
              const now = clock.now();
              await store.putPermission({ ...p, system: true, createdAt: now, updatedAt: now });
            }
          }
        }
        catalogVersion++;
        await loadCatalog();
      })();
      initPromise.catch(() => {
        initPromise = undefined;
      });
    }
    return initPromise;
  };

  const loadCatalog = async (): Promise<Catalog> => {
    if (loading) return loading;
    const version = catalogVersion;
    loading = (async () => {
      try {
        const [roles, permissions, ownership, policies] = await Promise.all([
          store.listRoles(),
          store.listPermissions(),
          store.listOwnershipRules(),
          store.listPolicies(),
        ]);
        if (cache) {
          try {
            const g = await cache.get<number>(`${cachePrefix}generation`);
            if (typeof g === 'number' && Number.isFinite(g)) generation = g;
          } catch (err) {
            logger.warn(
              { err: errMessage(err) },
              'rbac: cache read failed; using local generation',
            );
          }
        }
        const built = buildCatalog({
          roles,
          permissions,
          ownership,
          policies,
          now: clock.now(),
          logger,
        });
        current = built;
        loadedVersion = version;
        return built;
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  };

  const catalog = async (): Promise<Catalog> => {
    await ready();
    const c = current;
    const stale =
      !c ||
      loadedVersion !== catalogVersion ||
      (catalogTtlMs > 0 && clock.now() - c.loadedAt >= catalogTtlMs);
    if (!stale) return c;
    try {
      return await loadCatalog();
    } catch (err) {
      if (c) {
        logger.error(
          { err: errMessage(err) },
          'rbac: catalogue reload failed; using previous catalogue',
        );
        return c;
      }
      throw err;
    }
  };

  const assignmentsKey = (subjectId: string) =>
    `${cachePrefix}assignments:${generation}:${subjectId}`;

  const isAssignmentList = (value: unknown): value is AssignmentRecord[] =>
    Array.isArray(value) &&
    value.every(
      (a) =>
        isRecord(a) &&
        typeof a.id === 'string' &&
        typeof a.subjectId === 'string' &&
        typeof a.roleKey === 'string',
    );

  const loadAssignments = async (subjectId: string): Promise<readonly AssignmentRecord[]> => {
    if (cache) {
      try {
        const hit = await cache.get<unknown>(assignmentsKey(subjectId));
        if (hit !== undefined && isAssignmentList(hit)) return hit;
      } catch (err) {
        logger.warn({ err: errMessage(err) }, 'rbac: cache read failed; treated as a miss');
      }
    }
    const records = await store.listAssignmentsForSubject(subjectId);
    if (cache) {
      cache.set(assignmentsKey(subjectId), records, { ttlMs: cacheTtlMs }).catch((err: unknown) => {
        logger.warn({ err: errMessage(err) }, 'rbac: cache write failed');
      });
    }
    return records;
  };

  const invalidateSubject = async (subjectId: string) => {
    if (!cache) return;
    try {
      await cache.delete(assignmentsKey(subjectId));
    } catch (err) {
      logger.warn({ err: errMessage(err) }, 'rbac: cache delete failed');
    }
  };

  const bumpGeneration = async () => {
    generation = Math.max(generation + 1, clock.now());
    if (!cache) return;
    try {
      await cache.set(`${cachePrefix}generation`, generation);
    } catch (err) {
      logger.warn({ err: errMessage(err) }, 'rbac: cache generation write failed');
    }
  };

  const resolveScope = (
    subject: Subject,
    resource: ResourceRef | undefined,
    context: CheckContext | undefined,
  ): RbacScope => {
    if (resource?.orgId !== undefined) return makeScope(resource.orgId, resource.teamId);
    if (context?.scope !== undefined) return normaliseScope(context.scope, 'context.scope');
    if (subject.orgId !== undefined) return { orgId: subject.orgId };
    return {};
  };

  const appliesIn = (
    orgId: string | undefined,
    teamId: string | undefined,
    scope: RbacScope,
  ): boolean => {
    if (orgId === undefined) return true;
    if (scope.orgId !== orgId) return false;
    if (teamId === undefined) return scope.teamId === undefined || orgRolesApplyToTeams;
    return scope.teamId === teamId;
  };

  interface RoleCollection {
    keys: string[];
    applied: AppliedRole[];
    ignored: RbacExplanation['ignoredRoles'];
  }

  const collectRoles = (
    cat: Catalog,
    subject: Subject,
    assignments: readonly AssignmentRecord[],
    scope: RbacScope,
    trace: boolean,
  ): RoleCollection => {
    const now = clock.now();
    const keys: string[] = [];
    const applied: AppliedRole[] = [];
    const ignored: RbacExplanation['ignoredRoles'] = [];
    const consider = (
      key: string,
      orgId: string | undefined,
      teamId: string | undefined,
      expiresAt: number | undefined,
      source: 'assignment' | 'static',
      assignmentId: string | undefined,
    ) => {
      const role = cat.roles.get(key);
      if (!role) {
        if (trace) ignored.push({ key, reason: 'unknown' });
        return;
      }
      if (expiresAt !== undefined && expiresAt <= now) {
        if (trace) ignored.push({ key, reason: 'expired' });
        return;
      }
      if (!appliesIn(orgId, teamId, scope)) {
        if (trace) ignored.push({ key, reason: 'scope' });
        return;
      }
      const kind: ScopeKind =
        orgId === undefined ? 'global' : teamId === undefined ? 'org' : 'team';
      if (!role.record.assignableScopes.includes(kind)) {
        if (trace) ignored.push({ key, reason: 'not-assignable' });
        return;
      }
      if (!keys.includes(key)) keys.push(key);
      if (trace) {
        const entry: AppliedRole = {
          key,
          source,
          scope: makeScope(orgId, teamId),
          inherited: role.lineage.slice(1),
        };
        if (assignmentId !== undefined) entry.assignmentId = assignmentId;
        applied.push(entry);
      }
    };
    for (const a of assignments)
      consider(a.roleKey, a.orgId, a.teamId, a.expiresAt, 'assignment', a.id);
    if (staticRoles !== 'ignore' && subject.roles) {
      const orgId = staticRoles === 'auto' ? subject.orgId : undefined;
      for (const key of subject.roles) {
        if (typeof key === 'string')
          consider(key, orgId, undefined, undefined, 'static', undefined);
      }
    }
    return { keys, applied, ignored };
  };

  const timeContext = (now: number) => {
    const parts: Record<string, string> = {};
    for (const part of timeFormatter.formatToParts(new Date(now))) parts[part.type] = part.value;
    return {
      now,
      iso: new Date(now).toISOString(),
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      dayOfWeek: WEEKDAYS[parts.weekday ?? ''] ?? -1,
    };
  };

  const policyApplies = (
    policy: CompiledPolicy,
    perm: ParsedPermission,
    resource: ResourceRef | undefined,
    merged: MergedRoles,
  ): boolean => {
    const matchesPermission =
      policy.record.effect === 'deny'
        ? policy.permissions.overlaps(perm)
        : policy.permissions.covers(perm);
    if (!matchesPermission) return false;
    if (policy.resourceTypes && (!resource || !policy.resourceTypes.has(resource.type)))
      return false;
    if (policy.roles) {
      let any = false;
      for (const role of policy.roles) {
        if (merged.roles.has(role)) {
          any = true;
          break;
        }
      }
      if (!any) return false;
    }
    return true;
  };

  type GrantMemo = Map<string, Promise<GrantRecord[]>>;

  interface EvalInput {
    cat: Catalog;
    subject: Subject;
    assignments: readonly AssignmentRecord[];
    perm: ParsedPermission;
    resource: ResourceRef | undefined;
    context: CheckContext | undefined;
    trace: boolean;
    grantMemo?: GrantMemo;
  }

  const evaluate = async (input: EvalInput): Promise<RbacExplanation> => {
    const { cat, subject, perm, resource, context, trace } = input;
    const scope = resolveScope(subject, resource, context);
    const roles = collectRoles(cat, subject, input.assignments, scope, trace);
    const merged = cat.merged(roles.keys);
    const matches: TraceEntry[] = [];
    const policies: PolicyEvaluation[] = [];
    const result: RbacExplanation = {
      allowed: false,
      permission: perm.key,
      scope,
      reason: 'default',
      subjectId: subject.id,
      roles: roles.applied,
      effectiveRoles: trace ? [...merged.roles].sort() : [],
      ignoredRoles: roles.ignored,
      matches,
      policies,
    };
    if (resource) {
      result.resource =
        resource.id === undefined
          ? { type: resource.type }
          : { type: resource.type, id: resource.id };
    }
    const finish = (allowed: boolean, reason: DecisionReason, decisive: TraceEntry | undefined) => {
      result.allowed = allowed;
      result.reason = reason;
      if (decisive) result.decisive = decisive;
      return result;
    };

    // Role lineage lookup for traces: which assigned role brought an effective role in.
    const viaOf = (effectiveRole: string): string => {
      for (const key of roles.keys) {
        if (cat.roles.get(key)?.lineage.includes(effectiveRole)) return key;
      }
      return effectiveRole;
    };
    const roleEntries = (effect: Effect): TraceEntry[] => {
      const out: TraceEntry[] = [];
      for (const key of [...merged.roles].sort()) {
        const record = cat.roles.get(key)?.record;
        if (!record) continue;
        const list = effect === 'deny' ? record.denies : record.permissions;
        for (const pattern of list) {
          const p = parsePermission(pattern);
          const hit =
            effect === 'deny' ? matchSegments(p, perm, 'overlap') : matchSegments(p, perm, 'cover');
          if (hit) out.push({ type: 'role', effect, role: key, via: viaOf(key), pattern: p.key });
        }
      }
      return out;
    };

    let firstDeny: TraceEntry | undefined;
    let firstDenyReason: DecisionReason = 'default';
    const noteDeny = (entries: TraceEntry[], reason: DecisionReason) => {
      if (entries.length === 0) return;
      matches.push(...entries);
      if (!firstDeny) {
        firstDeny = entries[0];
        firstDenyReason = reason;
      }
    };

    // 1. Role denies.
    if (merged.deny.overlaps(perm)) {
      const entries = roleEntries('deny');
      if (!trace) return finish(false, 'role', entries[0]);
      noteDeny(entries, 'role');
    }

    // 2. Resource grants (one indexed query per resource with an id).
    let grants: GrantRecord[] = [];
    if (resource?.id !== undefined) {
      const memoKey = `${resource.type}\u0000${resource.id}`;
      let pending = input.grantMemo?.get(memoKey);
      if (!pending) {
        pending = store.findGrants({
          resourceType: resource.type,
          resourceId: resource.id,
          subjectId: subject.id,
          roleKeys: [...merged.roles],
        });
        input.grantMemo?.set(memoKey, pending);
      }
      const now = clock.now();
      grants = (await pending).filter(
        (g) =>
          (g.expiresAt === undefined || g.expiresAt > now) &&
          (g.orgId === undefined || g.orgId === scope.orgId) &&
          (g.subjectId === subject.id || (g.roleKey !== undefined && merged.roles.has(g.roleKey))),
      );
    }
    const grantEntries = (effect: Effect): TraceEntry[] => {
      const out: TraceEntry[] = [];
      for (const g of grants) {
        if (g.effect !== effect) continue;
        for (const pattern of g.permissions) {
          const p = parsePermission(pattern);
          if (!matchSegments(p, perm, effect === 'deny' ? 'overlap' : 'cover')) continue;
          const entry: TraceEntry = { type: 'grant', effect, grantId: g.id, pattern: p.key };
          if (g.subjectId !== undefined) entry.subjectId = g.subjectId;
          if (g.roleKey !== undefined) entry.roleKey = g.roleKey;
          out.push(entry);
          if (!trace) return out;
        }
      }
      return out;
    };
    const grantDenies = grantEntries('deny');
    if (grantDenies.length > 0) {
      if (!trace) return finish(false, 'grant', grantDenies[0]);
      noteDeny(grantDenies, 'grant');
    }

    // 3. Deny policies.
    let conditionInput: ConditionInput | undefined;
    const getInput = (usesTime: boolean): ConditionInput => {
      if (!conditionInput) {
        conditionInput = { subject, resource, context: { ...(context ?? {}), scope } };
      }
      const ctx = conditionInput.context as Record<string, unknown>;
      if (usesTime && ctx.time === undefined) ctx.time = timeContext(clock.now());
      return conditionInput;
    };
    const policyEntries = (list: readonly CompiledPolicy[], effect: Effect): TraceEntry[] => {
      const out: TraceEntry[] = [];
      for (const policy of list) {
        if (!policyApplies(policy, perm, resource, merged)) continue;
        const value = policy.condition(getInput(policy.usesTime));
        if (trace) policies.push({ policyId: policy.record.id, effect, result: value });
        if (!value) continue;
        const pattern =
          effect === 'deny'
            ? (policy.permissions.overlappingPatterns(perm)[0] ?? perm.key)
            : (policy.permissions.coveringPatterns(perm)[0] ?? perm.key);
        out.push({ type: 'policy', effect, policyId: policy.record.id, pattern });
        if (!trace) return out;
      }
      return out;
    };
    const policyDenies = policyEntries(cat.denyPolicies, 'deny');
    if (policyDenies.length > 0) {
      if (!trace) return finish(false, 'policy', policyDenies[0]);
      noteDeny(policyDenies, 'policy');
    }

    // 4. Allows: roles, grants, ownership, policies.
    let firstAllow: TraceEntry | undefined;
    let firstAllowReason: DecisionReason = 'default';
    const noteAllow = (entries: TraceEntry[], reason: DecisionReason): boolean => {
      if (entries.length === 0) return false;
      matches.push(...entries);
      if (!firstAllow) {
        firstAllow = entries[0];
        firstAllowReason = reason;
      }
      return !trace;
    };

    if (merged.allow.covers(perm)) {
      const entries = trace ? roleEntries('allow') : [];
      if (!trace) {
        const entry = roleEntries('allow')[0];
        return finish(true, 'role', entry);
      }
      noteAllow(entries, 'role');
    }
    if (noteAllow(grantEntries('allow'), 'grant')) return finish(true, 'grant', firstAllow);

    if (resource && resource.ownerId !== undefined && resource.ownerId === subject.id) {
      const rules = [
        ...(cat.ownershipByType.get(resource.type) ?? []),
        ...(cat.ownershipByType.get('*') ?? []),
      ];
      const entries: TraceEntry[] = [];
      for (const rule of rules) {
        if (!rule.allow.covers(perm)) continue;
        for (const pattern of rule.allow.coveringPatterns(perm)) {
          entries.push({
            type: 'ownership',
            effect: 'allow',
            ruleId: rule.record.id,
            resourceType: rule.record.resourceType,
            pattern,
          });
          if (!trace) break;
        }
        if (!trace) break;
      }
      if (noteAllow(entries, 'ownership')) return finish(true, 'ownership', firstAllow);
    }

    if (!firstAllow || trace) {
      if (noteAllow(policyEntries(cat.allowPolicies, 'allow'), 'policy')) {
        return finish(true, 'policy', firstAllow);
      }
    }

    if (firstDeny) return finish(false, firstDenyReason, firstDeny);
    if (firstAllow) return finish(true, firstAllowReason, firstAllow);
    return finish(false, 'default', undefined);
  };

  const toDecision = (e: RbacExplanation): RbacDecision => {
    const d: RbacDecision = {
      allowed: e.allowed,
      permission: e.permission,
      scope: e.scope,
      reason: e.reason,
    };
    if (e.decisive) d.decisive = e.decisive;
    return d;
  };

  const auditDenied = (
    subject: Subject,
    decision: RbacDecision,
    resource: ResourceRef | undefined,
  ) => {
    if (decision.allowed || deniedRate <= 0 || !auditor.enabled) return;
    if (deniedRate < 1 && random() >= deniedRate) return;
    const event: Parameters<Auditor['record']>[0] = {
      action: 'rbac.access.denied',
      outcome: 'denied',
      category: 'security',
      actor:
        subject.type === undefined ? { id: subject.id } : { id: subject.id, type: subject.type },
      metadata: { permission: decision.permission, reason: decision.reason },
    };
    if (resource)
      event.resource =
        resource.id === undefined
          ? { type: resource.type }
          : { type: resource.type, id: resource.id };
    if (decision.scope.orgId !== undefined) event.tenantId = decision.scope.orgId;
    auditor.record(event).catch(() => undefined);
  };

  const single = async (
    subject: Subject,
    permission: string,
    resource: ResourceRef | undefined,
    context: CheckContext | undefined,
    trace: boolean,
  ): Promise<RbacExplanation> => {
    assertSubject(subject);
    assertResource(resource);
    const perm = parsePermission(permission);
    const cat = await catalog();
    const assignments = await loadAssignments(subject.id);
    return evaluate({ cat, subject, assignments, perm, resource, context, trace });
  };

  const decide = async (
    subject: Subject,
    permission: string,
    resource?: ResourceRef,
    context?: CheckContext,
  ): Promise<RbacDecision> => {
    const decision = toDecision(await single(subject, permission, resource, context, false));
    auditDenied(subject, decision, resource);
    return decision;
  };

  const can = async (
    subject: Subject,
    permission: string,
    resource?: ResourceRef,
    context?: CheckContext,
  ) => (await decide(subject, permission, resource, context)).allowed;

  const checkMany = async (subject: Subject, checks: readonly BatchCheck[]): Promise<boolean[]> => {
    assertSubject(subject);
    const parsed = checks.map((c) => {
      assertResource(c.resource);
      return parsePermission(c.permission);
    });
    const cat = await catalog();
    const assignments = await loadAssignments(subject.id);
    const grantMemo: GrantMemo = new Map();
    const out: boolean[] = [];
    for (const [i, c] of checks.entries()) {
      const perm = parsed[i] as ParsedPermission;
      const e = await evaluate({
        cat,
        subject,
        assignments,
        perm,
        resource: c.resource,
        context: c.context,
        trace: false,
        grantMemo,
      });
      auditDenied(subject, toDecision(e), c.resource);
      out.push(e.allowed);
    }
    return out;
  };

  const effectiveRoles = async (subject: Subject, scope: RbacScope | undefined) => {
    assertSubject(subject);
    const cat = await catalog();
    const s =
      scope === undefined ? resolveScope(subject, undefined, undefined) : normaliseScope(scope);
    const assignments = await loadAssignments(subject.id);
    const roles = collectRoles(cat, subject, assignments, s, false);
    return { cat, scope: s, merged: cat.merged(roles.keys), assignments };
  };

  const engine: Rbac = {
    init: ready,
    can,
    async check(subject, permission, resource, context) {
      const decision = await decide(subject, permission, resource, context);
      if (!decision.allowed) throw new RbacForbiddenError('Forbidden', decision.permission);
    },
    async canAll(subject, permissions, resource, context) {
      if (permissions.length === 0) return false;
      const results = await checkMany(
        subject,
        permissions.map((permission) => withOptional({ permission }, resource, context)),
      );
      return results.every(Boolean);
    },
    async canAny(subject, permissions, resource, context) {
      if (permissions.length === 0) return false;
      const results = await checkMany(
        subject,
        permissions.map((permission) => withOptional({ permission }, resource, context)),
      );
      return results.some(Boolean);
    },
    checkMany,
    decide,
    async explain(subject, permission, resource, context) {
      return single(subject, permission, resource, context, true);
    },
    async permissionsFor(subject, scope) {
      const { scope: s, merged } = await effectiveRoles(subject, scope);
      return {
        subjectId: subject.id,
        scope: s,
        roles: [...merged.roles].sort(),
        permissions: merged.allow.patterns(),
        denies: merged.deny.patterns(),
      };
    },
    async rolesFor(subject, scope) {
      const { merged } = await effectiveRoles(subject, scope);
      return [...merged.roles].sort();
    },
    async hasRole(subject, role, scope) {
      const { merged } = await effectiveRoles(subject, scope);
      return merged.roles.has(role);
    },
    async createPermissionSnapshot(subject, snapshotOptions = {}) {
      const requested = snapshotOptions.permissions?.map((p) => parsePermission(p));
      if (requested && requested.length > 200) {
        throw new RbacValidationError('At most 200 permissions per snapshot', [
          { path: 'permissions', message: 'too many' },
        ]);
      }
      const resources = snapshotOptions.resources ?? [];
      if (resources.length > 100) {
        throw new RbacValidationError('At most 100 resources per snapshot', [
          { path: 'resources', message: 'too many' },
        ]);
      }
      if (resources.length > 0 && !requested) {
        throw new RbacValidationError('resources requires permissions', [
          { path: 'resources', message: 'requires permissions' },
        ]);
      }
      for (const r of resources) assertResource(r);
      const { cat, scope, merged, assignments } = await effectiveRoles(
        subject,
        snapshotOptions.scope,
      );
      const relevant = (pattern: string) =>
        !requested || requested.some((r) => matchSegments(parsePermission(pattern), r, 'overlap'));
      const limit = Math.min(
        snapshotOptions.maxGrants ?? limits.maxSnapshotGrants,
        limits.maxSnapshotGrants,
      );
      const withIds = resources.filter(
        (r): r is ResourceRef & { id: string } => r.id !== undefined,
      );
      const rawGrants =
        limit > 0
          ? await store.listGrantsForPrincipals({
              subjectId: subject.id,
              roleKeys: [...merged.roles],
              limit,
              ...(snapshotOptions.resources
                ? { resources: withIds.map((r) => ({ type: r.type, id: r.id })) }
                : {}),
            })
          : [];
      const now = clock.now();
      const grants: SnapshotGrant[] = [];
      for (const g of rawGrants) {
        if (g.expiresAt !== undefined && g.expiresAt <= now) continue;
        if (g.orgId !== undefined && g.orgId !== scope.orgId) continue;
        const permissions = g.permissions.filter(relevant);
        if (permissions.length === 0) continue;
        grants.push({
          resourceType: g.resourceType,
          resourceId: g.resourceId,
          effect: g.effect,
          permissions,
        });
      }
      const snapshot: PermissionSnapshot = {
        version: 1,
        subjectId: subject.id,
        scope,
        generatedAt: now,
        roles: [...merged.roles].sort(),
        permissions: merged.allow.patterns().filter(relevant),
        denies: merged.deny.patterns().filter(relevant),
        ownership: cat.ownership
          .map((o) => ({
            resourceType: o.record.resourceType,
            permissions: o.record.permissions.filter(relevant),
          }))
          .filter((o) => o.permissions.length > 0),
        grants,
        decisions: {},
        resourceDecisions: [] as SnapshotResourceDecision[],
      };
      if (requested) {
        const context: CheckContext = { ...(snapshotOptions.context ?? {}), scope };
        const grantMemo: GrantMemo = new Map();
        for (const perm of requested) {
          const e = await evaluate({
            cat,
            subject,
            assignments,
            perm,
            resource: undefined,
            context,
            trace: false,
            grantMemo,
          });
          snapshot.decisions[perm.key] = e.allowed;
        }
        const resourceDecisions: SnapshotResourceDecision[] = [];
        for (const resource of resources) {
          const allowed: string[] = [];
          for (const perm of requested) {
            const e = await evaluate({
              cat,
              subject,
              assignments,
              perm,
              resource,
              context,
              trace: false,
              grantMemo,
            });
            if (e.allowed) allowed.push(perm.key);
          }
          resourceDecisions.push(
            resource.id === undefined
              ? { type: resource.type, allowed }
              : { type: resource.type, id: resource.id, allowed },
          );
        }
        snapshot.resourceDecisions = resourceDecisions;
      }
      return snapshot;
    },
    async invalidate(subjectId) {
      catalogVersion++;
      if (subjectId !== undefined) await invalidateSubject(subjectId);
    },
    get admin() {
      return admin;
    },
    store,
    adminPermission,
    adminReadPermission,
  };

  const internals: EngineInternals = {
    store,
    clock,
    generateId,
    logger,
    auditor,
    limits,
    requireRegisteredPermissions: options.requireRegisteredPermissions ?? true,
    preventEscalation: options.preventEscalation ?? true,
    adminPermission,
    adminReadPermission,
    ready,
    catalog,
    invalidateCatalog() {
      catalogVersion++;
    },
    invalidateSubject,
    bumpGeneration,
    can,
    async effectiveRolePatterns(roleKey) {
      const cat = await catalog();
      return cat.roles.get(roleKey)?.allow.patterns() ?? [];
    },
  };
  const admin = createAdmin(internals);
  return engine;
}

function withOptional(
  base: { permission: string },
  resource: ResourceRef | undefined,
  context: CheckContext | undefined,
): BatchCheck {
  const out: BatchCheck = { ...base };
  if (resource !== undefined) out.resource = resource;
  if (context !== undefined) out.context = context;
  return out;
}

function matchSegments(
  held: ParsedPermission,
  requested: ParsedPermission,
  mode: 'cover' | 'overlap',
): boolean {
  if (mode === 'cover') {
    return (
      (held.resource === '*' || held.resource === requested.resource) &&
      (held.action === '*' || held.action === requested.action)
    );
  }
  return (
    (held.resource === '*' || requested.resource === '*' || held.resource === requested.resource) &&
    (held.action === '*' || requested.action === '*' || held.action === requested.action)
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
