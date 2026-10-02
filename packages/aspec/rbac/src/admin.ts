import { type AdminCallOptions, actorOf, type RbacAuditAction } from './audit.js';
import { findCycle } from './catalog.js';
import { patternIsRegistered, readPolicyInput } from './config.js';
import type { EngineInternals } from './engine.js';
import {
  RbacConflictError,
  RbacCycleDetectedError,
  RbacEscalationError,
  RbacImmutableError,
  RbacInUseError,
  RbacLimitError,
  RbacNotFoundError,
  RbacRoleNotFoundError,
  RbacValidationError,
} from './errors.js';
import { parsePermission } from './permissions.js';
import type { Subject } from './ports.js';
import type {
  AssignmentRecord,
  Effect,
  GrantRecord,
  OwnershipRuleRecord,
  Page,
  PermissionRecord,
  PolicyRecord,
  RbacScope,
  RoleRecord,
  ScopeKind,
} from './types.js';
import {
  checkUnknownKeys,
  Issues,
  isRecord,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  makeScope,
  RECORD_ID,
  RESOURCE_TYPE,
  ROLE_KEY,
  readIdentifier,
  readKeyList,
  readLimit,
  readPattern,
  readPermissionList,
  readScope,
  readScopeKinds,
  readText,
  readTimestamp,
  scopeKind,
} from './validate.js';

export interface CreatePermissionInput {
  key: string;
  description?: string;
}

export interface UpdatePermissionInput {
  description?: string;
}

export interface CreateRoleInput {
  key: string;
  name?: string;
  description?: string;
  permissions?: readonly string[];
  denies?: readonly string[];
  parents?: readonly string[];
  assignableScopes?: readonly ScopeKind[];
}

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
  permissions?: readonly string[];
  denies?: readonly string[];
  parents?: readonly string[];
  assignableScopes?: readonly ScopeKind[];
  /** Optimistic concurrency: the version the caller last read. */
  expectedVersion?: number;
}

export interface AssignRoleInput {
  subjectId: string;
  roleKey: string;
  scope?: RbacScope;
  expiresAt?: number | Date | string;
}

export interface RevokeRoleInput {
  id?: string;
  subjectId?: string;
  roleKey?: string;
  scope?: RbacScope;
}

export interface GrantInput {
  subjectId?: string;
  roleKey?: string;
  resourceType: string;
  resourceId: string;
  orgId?: string;
  permissions: readonly string[];
  effect?: Effect;
  expiresAt?: number | Date | string;
}

export interface OwnershipRuleInput {
  id?: string;
  resourceType: string;
  permissions: readonly string[];
  description?: string;
}

export interface UpdateOwnershipRuleInput {
  permissions?: readonly string[];
  description?: string | null;
}

export interface PolicyInput {
  id?: string;
  description?: string;
  effect: Effect;
  permissions: readonly string[];
  resourceTypes?: readonly string[];
  roles?: readonly string[];
  condition: unknown;
}

export interface UpdatePolicyInput {
  description?: string | null;
  effect?: Effect;
  permissions?: readonly string[];
  resourceTypes?: readonly string[] | null;
  roles?: readonly string[] | null;
  condition?: unknown;
}

export interface ListFilter {
  limit?: number;
  cursor?: string;
  subjectId?: string;
  roleKey?: string;
  orgId?: string | null;
  teamId?: string | null;
  resourceType?: string;
  resourceId?: string;
}

export interface RbacAdmin {
  listPermissions(): Promise<PermissionRecord[]>;
  createPermission(
    input: CreatePermissionInput,
    call?: AdminCallOptions,
  ): Promise<PermissionRecord>;
  updatePermission(
    key: string,
    input: UpdatePermissionInput,
    call?: AdminCallOptions,
  ): Promise<PermissionRecord>;
  deletePermission(key: string, options?: { force?: boolean } & AdminCallOptions): Promise<void>;

  listRoles(): Promise<RoleRecord[]>;
  getRole(key: string): Promise<RoleRecord>;
  effectivePermissions(roleKey: string): Promise<string[]>;
  createRole(input: CreateRoleInput, call?: AdminCallOptions): Promise<RoleRecord>;
  updateRole(key: string, input: UpdateRoleInput, call?: AdminCallOptions): Promise<RoleRecord>;
  deleteRole(key: string, options?: { force?: boolean } & AdminCallOptions): Promise<void>;

  assignRole(input: AssignRoleInput, call?: AdminCallOptions): Promise<AssignmentRecord>;
  revokeRole(input: RevokeRoleInput, call?: AdminCallOptions): Promise<AssignmentRecord>;
  listAssignments(filter?: ListFilter): Promise<Page<AssignmentRecord>>;

  grant(input: GrantInput, call?: AdminCallOptions): Promise<GrantRecord>;
  revokeGrant(id: string, call?: AdminCallOptions): Promise<GrantRecord>;
  listGrants(filter?: ListFilter): Promise<Page<GrantRecord>>;

  listOwnershipRules(): Promise<OwnershipRuleRecord[]>;
  createOwnershipRule(
    input: OwnershipRuleInput,
    call?: AdminCallOptions,
  ): Promise<OwnershipRuleRecord>;
  updateOwnershipRule(
    id: string,
    input: UpdateOwnershipRuleInput,
    call?: AdminCallOptions,
  ): Promise<OwnershipRuleRecord>;
  deleteOwnershipRule(id: string, options?: { force?: boolean } & AdminCallOptions): Promise<void>;

  listPolicies(): Promise<PolicyRecord[]>;
  createPolicy(input: PolicyInput, call?: AdminCallOptions): Promise<PolicyRecord>;
  updatePolicy(
    id: string,
    input: UpdatePolicyInput,
    call?: AdminCallOptions,
  ): Promise<PolicyRecord>;
  deletePolicy(id: string, options?: { force?: boolean } & AdminCallOptions): Promise<void>;

  purgeExpired(call?: AdminCallOptions): Promise<{ assignments: number; grants: number }>;
}

function freezeRecord<T extends object>(record: T): T {
  return Object.freeze(record);
}

function callMeta(call: AdminCallOptions | undefined): AdminCallOptions {
  return call ?? {};
}

/** Creates the administrative API bound to an engine's internals. */
export function createAdmin(internals: EngineInternals): RbacAdmin {
  const {
    store,
    clock,
    generateId,
    auditor,
    limits,
    requireRegisteredPermissions,
    preventEscalation,
  } = internals;

  const registeredKeys = async (): Promise<Set<string>> => {
    const cat = await internals.catalog();
    return new Set(cat.permissions.keys());
  };

  const assertRegistered = async (patterns: readonly string[], path: string) => {
    if (!requireRegisteredPermissions) return;
    const registered = await registeredKeys();
    const issues = new Issues();
    for (const [i, pattern] of patterns.entries()) {
      if (!patternIsRegistered(pattern, registered)) {
        issues.add(`${path}.${i}`, `permission "${pattern}" is not registered`);
      }
    }
    if (!issues.empty) {
      throw new RbacValidationError('Unknown permission', issues.list, 'RBAC_UNKNOWN_PERMISSION');
    }
  };

  const assertNoEscalation = async (
    actor: Subject | undefined,
    patterns: readonly string[],
    scope: RbacScope,
  ) => {
    if (!preventEscalation || !actor || patterns.length === 0) return;
    for (const pattern of patterns) {
      const p = parsePermission(pattern);
      if (p.wildcard) {
        // Actor must hold a covering pattern via effective role permissions or admin.
        const ok = await internals.can(actor, pattern, undefined, { scope });
        if (!ok) throw new RbacEscalationError(pattern);
        continue;
      }
      const ok = await internals.can(actor, pattern, undefined, { scope });
      if (!ok) throw new RbacEscalationError(pattern);
    }
  };

  const touchCatalog = () => {
    internals.invalidateCatalog();
  };

  const recordAudit = async (
    action: RbacAuditAction,
    call: AdminCallOptions | undefined,
    parts: {
      resource?: { type: string; id: string };
      changes?: { before?: unknown; after?: unknown };
      tenantId?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ) => {
    const event: Parameters<typeof auditor.record>[0] = {
      action,
      outcome: 'success',
      category: 'admin',
    };
    const actor = actorOf(callMeta(call));
    if (actor) event.actor = actor;
    if (parts.resource) event.resource = parts.resource;
    if (parts.changes) event.changes = parts.changes;
    if (parts.tenantId !== undefined) event.tenantId = parts.tenantId;
    if (parts.metadata) event.metadata = parts.metadata;
    if (call?.requestId !== undefined) event.requestId = call.requestId;
    await auditor.record(event);
  };

  const admin: RbacAdmin = {
    async listPermissions() {
      await internals.ready();
      return store.listPermissions();
    },

    async createPermission(input, call) {
      await internals.ready();
      const issues = new Issues();
      if (!isRecord(input))
        throw new RbacValidationError('Invalid permission', [
          { path: '', message: 'must be an object' },
        ]);
      checkUnknownKeys(input, ['key', 'description'], '', issues);
      const key = (() => {
        try {
          return parsePermission(input.key).key;
        } catch {
          issues.add('key', 'must be a concrete permission of the form resource:action');
          return undefined;
        }
      })();
      if (key?.includes('*'))
        issues.add('key', 'wildcards are not allowed for registered permissions');
      const description = readText(
        input.description,
        'description',
        issues,
        MAX_DESCRIPTION_LENGTH,
      );
      issues.throwIfAny('Invalid permission');
      if (!key) throw new RbacValidationError('Invalid permission');
      const existing = await store.getPermission(key);
      if (existing) throw new RbacConflictError(`Permission "${key}" already exists`);
      const now = clock.now();
      const record: PermissionRecord = freezeRecord({
        key,
        system: false,
        createdAt: now,
        updatedAt: now,
        ...(description === undefined ? {} : { description }),
      });
      await store.putPermission(record);
      touchCatalog();
      await recordAudit('rbac.permission.created', call, {
        resource: { type: 'rbac_permission', id: key },
        changes: { after: record },
      });
      return record;
    },

    async updatePermission(key, input, call) {
      await internals.ready();
      const existing = await store.getPermission(key);
      if (!existing)
        throw new RbacNotFoundError(
          'RBAC_PERMISSION_NOT_FOUND',
          `Permission "${key}" does not exist`,
        );
      if (existing.system)
        throw new RbacImmutableError(`System permission "${key}" cannot be changed`);
      const issues = new Issues();
      if (!isRecord(input))
        throw new RbacValidationError('Invalid permission', [
          { path: '', message: 'must be an object' },
        ]);
      checkUnknownKeys(input, ['description'], '', issues);
      const description = readText(
        input.description,
        'description',
        issues,
        MAX_DESCRIPTION_LENGTH,
      );
      issues.throwIfAny('Invalid permission');
      const record: PermissionRecord = freezeRecord({
        ...existing,
        updatedAt: clock.now(),
        ...(description === undefined ? {} : { description }),
      });
      await store.putPermission(record);
      touchCatalog();
      await recordAudit('rbac.permission.updated', call, {
        resource: { type: 'rbac_permission', id: key },
        changes: { before: existing, after: record },
      });
      return record;
    },

    async deletePermission(key, options = {}) {
      await internals.ready();
      const existing = await store.getPermission(key);
      if (!existing)
        throw new RbacNotFoundError(
          'RBAC_PERMISSION_NOT_FOUND',
          `Permission "${key}" does not exist`,
        );
      if (existing.system)
        throw new RbacImmutableError(`System permission "${key}" cannot be deleted`);
      if (!options.force) {
        const roles = await store.listRoles();
        const users = roles.filter((r) => r.permissions.includes(key) || r.denies.includes(key));
        if (users.length > 0) {
          throw new RbacInUseError(
            'RBAC_PERMISSION_IN_USE',
            `Permission "${key}" is used by roles`,
            {
              roles: users.map((r) => r.key),
            },
          );
        }
      }
      await store.deletePermission(key);
      touchCatalog();
      await recordAudit('rbac.permission.deleted', options, {
        resource: { type: 'rbac_permission', id: key },
        changes: { before: existing },
      });
    },

    async listRoles() {
      await internals.ready();
      return store.listRoles();
    },

    async getRole(key) {
      await internals.ready();
      const role = await store.getRole(key);
      if (!role) throw new RbacRoleNotFoundError(key);
      return role;
    },

    async effectivePermissions(roleKey) {
      await internals.ready();
      const patterns = await internals.effectiveRolePatterns(roleKey);
      if (patterns.length === 0) {
        const role = await store.getRole(roleKey);
        if (!role) throw new RbacRoleNotFoundError(roleKey);
      }
      return patterns;
    },

    async createRole(input, call) {
      await internals.ready();
      const issues = new Issues();
      if (!isRecord(input))
        throw new RbacValidationError('Invalid role', [{ path: '', message: 'must be an object' }]);
      checkUnknownKeys(
        input,
        ['key', 'name', 'description', 'permissions', 'denies', 'parents', 'assignableScopes'],
        '',
        issues,
      );
      const key = readPattern(input.key, ROLE_KEY, 'key', issues, true, 'role key');
      const name = readText(input.name ?? key, 'name', issues, MAX_NAME_LENGTH, true) ?? key ?? '';
      const description = readText(
        input.description,
        'description',
        issues,
        MAX_DESCRIPTION_LENGTH,
      );
      const permissions =
        readPermissionList(input.permissions, 'permissions', issues, {
          max: limits.maxPermissionsPerRole,
        }) ?? [];
      const denies =
        readPermissionList(input.denies, 'denies', issues, { max: limits.maxPermissionsPerRole }) ??
        [];
      const parents = readKeyList(input.parents, ROLE_KEY, 'parents', issues, 'role key') ?? [];
      const assignableScopes =
        readScopeKinds(input.assignableScopes, 'assignableScopes', issues) ??
        (['global', 'org', 'team'] as ScopeKind[]);
      issues.throwIfAny('Invalid role');
      if (!key) throw new RbacValidationError('Invalid role');

      const roles = await store.listRoles();
      if (roles.length >= limits.maxRoles) {
        throw new RbacLimitError(`At most ${limits.maxRoles} roles are allowed`);
      }
      if (roles.some((r) => r.key === key)) {
        throw new RbacConflictError(`Role "${key}" already exists`);
      }
      for (const parent of parents) {
        if (!roles.some((r) => r.key === parent) && parent !== key) {
          throw new RbacRoleNotFoundError(parent);
        }
      }
      const graph = new Map(roles.map((r) => [r.key, r.parents] as const));
      graph.set(key, parents);
      const cycle = findCycle(graph, [key]);
      if (cycle) throw new RbacCycleDetectedError(cycle);

      await assertRegistered([...permissions, ...denies], 'permissions');
      await assertNoEscalation(call?.actor, permissions, {});

      const now = clock.now();
      const record: RoleRecord = freezeRecord({
        key,
        name,
        permissions: Object.freeze([...permissions]),
        denies: Object.freeze([...denies]),
        parents: Object.freeze([...parents]),
        assignableScopes: Object.freeze([...assignableScopes]),
        system: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
        ...(description === undefined ? {} : { description }),
      });
      const created = await store.insertRole(record);
      if (!created) throw new RbacConflictError(`Role "${key}" already exists`);
      touchCatalog();
      await recordAudit('rbac.role.created', call, {
        resource: { type: 'rbac_role', id: key },
        changes: { after: record },
      });
      return record;
    },

    async updateRole(key, input, call) {
      await internals.ready();
      const issues = new Issues();
      if (!isRecord(input))
        throw new RbacValidationError('Invalid role', [{ path: '', message: 'must be an object' }]);
      checkUnknownKeys(
        input,
        [
          'name',
          'description',
          'permissions',
          'denies',
          'parents',
          'assignableScopes',
          'expectedVersion',
        ],
        '',
        issues,
      );

      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await store.getRole(key);
        if (!existing) throw new RbacRoleNotFoundError(key);
        if (existing.system) throw new RbacImmutableError(`System role "${key}" cannot be changed`);

        const name =
          input.name === undefined
            ? existing.name
            : (readText(input.name, 'name', issues, MAX_NAME_LENGTH, true) ?? existing.name);
        let description: string | undefined = existing.description;
        if (input.description === null) description = undefined;
        else if (input.description !== undefined) {
          description = readText(input.description, 'description', issues, MAX_DESCRIPTION_LENGTH);
        }
        const permissions =
          input.permissions === undefined
            ? [...existing.permissions]
            : (readPermissionList(input.permissions, 'permissions', issues, {
                max: limits.maxPermissionsPerRole,
              }) ?? []);
        const denies =
          input.denies === undefined
            ? [...existing.denies]
            : (readPermissionList(input.denies, 'denies', issues, {
                max: limits.maxPermissionsPerRole,
              }) ?? []);
        const parents =
          input.parents === undefined
            ? [...existing.parents]
            : (readKeyList(input.parents, ROLE_KEY, 'parents', issues, 'role key') ?? []);
        const assignableScopes =
          input.assignableScopes === undefined
            ? [...existing.assignableScopes]
            : (readScopeKinds(input.assignableScopes, 'assignableScopes', issues) ?? [
                ...existing.assignableScopes,
              ]);
        if (
          input.expectedVersion !== undefined &&
          (typeof input.expectedVersion !== 'number' || !Number.isInteger(input.expectedVersion))
        ) {
          issues.add('expectedVersion', 'must be an integer');
        }
        issues.throwIfAny('Invalid role');

        const roles = await store.listRoles();
        for (const parent of parents) {
          if (parent === key) throw new RbacCycleDetectedError([key, key]);
          if (!roles.some((r) => r.key === parent)) throw new RbacRoleNotFoundError(parent);
        }
        const graph = new Map(
          roles.map((r) => [r.key, r.key === key ? parents : r.parents] as const),
        );
        const cycle = findCycle(graph, [key]);
        if (cycle) throw new RbacCycleDetectedError(cycle);

        const added = permissions.filter((p) => !existing.permissions.includes(p));
        await assertRegistered(
          [...added, ...denies.filter((d) => !existing.denies.includes(d))],
          'permissions',
        );
        if (added.length > 0) {
          const beforePatterns = await internals.effectiveRolePatterns(key);
          const beforeSet = new Set(beforePatterns);
          // Temporarily compute new effective by checking added patterns only.
          await assertNoEscalation(
            call?.actor,
            added.filter((p) => !beforeSet.has(p)),
            {},
          );
        }

        const expectedVersion: number =
          typeof input.expectedVersion === 'number' ? input.expectedVersion : existing.version;
        const now = clock.now();
        const record: RoleRecord = freezeRecord({
          key,
          name,
          permissions: Object.freeze(permissions),
          denies: Object.freeze(denies),
          parents: Object.freeze(parents),
          assignableScopes: Object.freeze(assignableScopes),
          system: false,
          version: existing.version + 1,
          createdAt: existing.createdAt,
          updatedAt: now,
          ...(description === undefined ? {} : { description }),
        });

        const revision = await store.getRolesRevision();
        const ok = await store.transaction(async (tx) => {
          const bumped = await tx.bumpRolesRevision(revision);
          if (!bumped) return false;
          return tx.updateRole(record, expectedVersion);
        });
        if (!ok) {
          if (input.expectedVersion !== undefined) {
            throw new RbacConflictError(`Role "${key}" was modified concurrently`);
          }
          continue;
        }
        touchCatalog();
        await recordAudit('rbac.role.updated', call, {
          resource: { type: 'rbac_role', id: key },
          changes: { before: existing, after: record },
        });
        return record;
      }
      throw new RbacConflictError(`Role "${key}" was modified concurrently`);
    },

    async deleteRole(key, options = {}) {
      await internals.ready();
      const existing = await store.getRole(key);
      if (!existing) throw new RbacRoleNotFoundError(key);
      if (existing.system) throw new RbacImmutableError(`System role "${key}" cannot be deleted`);

      const policies = await store.listPolicies();
      const blocking = policies.filter((p) => p.roles?.includes(key));
      if (blocking.length > 0) {
        throw new RbacInUseError(
          'RBAC_ROLE_IN_USE',
          `Role "${key}" is referenced by policies and cannot be deleted`,
          { policies: blocking.map((p) => p.id) },
        );
      }

      const assignmentCount = await store.countAssignments({ roleKey: key });
      const grantCount = await store.countGrants({ roleKey: key });
      const children = (await store.listRoles()).filter((r) => r.parents.includes(key));
      if (!options.force && (assignmentCount > 0 || grantCount > 0 || children.length > 0)) {
        throw new RbacInUseError('RBAC_ROLE_IN_USE', `Role "${key}" is still in use`, {
          assignments: assignmentCount,
          grants: grantCount,
          children: children.map((c) => c.key),
        });
      }

      await store.transaction(async (tx) => {
        if (options.force) {
          await tx.deleteAssignmentsForRole(key);
          await tx.deleteGrantsForRole(key);
          for (const child of children) {
            const parents = child.parents.filter((p) => p !== key);
            await tx.updateRole(
              freezeRecord({
                ...child,
                parents: Object.freeze(parents),
                version: child.version + 1,
                updatedAt: clock.now(),
              }),
              child.version,
            );
          }
        }
        await tx.deleteRole(key);
        const rev = await tx.getRolesRevision();
        await tx.bumpRolesRevision(rev);
      });
      touchCatalog();
      await internals.bumpGeneration();
      await recordAudit('rbac.role.deleted', options, {
        resource: { type: 'rbac_role', id: key },
        changes: { before: existing },
      });
    },

    async assignRole(input, call) {
      await internals.ready();
      const issues = new Issues();
      if (!isRecord(input))
        throw new RbacValidationError('Invalid assignment', [
          { path: '', message: 'must be an object' },
        ]);
      checkUnknownKeys(input, ['subjectId', 'roleKey', 'scope', 'expiresAt'], '', issues);
      const subjectId = readIdentifier(input.subjectId, 'subjectId', issues, true);
      const roleKey = readPattern(input.roleKey, ROLE_KEY, 'roleKey', issues, true, 'role key');
      const scope = readScope(input.scope, 'scope', issues) ?? {};
      const expiresAt = readTimestamp(input.expiresAt, 'expiresAt', issues);
      issues.throwIfAny('Invalid assignment');
      if (!subjectId || !roleKey) throw new RbacValidationError('Invalid assignment');

      const role = await store.getRole(roleKey);
      if (!role) throw new RbacRoleNotFoundError(roleKey);
      const kind = scopeKind(scope);
      if (!role.assignableScopes.includes(kind)) {
        throw new RbacValidationError(`Role "${roleKey}" cannot be assigned in ${kind} scope`, [
          {
            path: 'scope',
            message: `not in assignableScopes (${role.assignableScopes.join(', ')})`,
          },
        ]);
      }

      const count = await store.countAssignments({ subjectId });
      if (count >= limits.maxAssignmentsPerSubject) {
        throw new RbacLimitError(
          `Subject has reached the limit of ${limits.maxAssignmentsPerSubject} assignments`,
        );
      }

      const now = clock.now();
      const record: AssignmentRecord = freezeRecord({
        id: generateId(),
        subjectId,
        roleKey,
        createdAt: now,
        ...(scope.orgId === undefined ? {} : { orgId: scope.orgId }),
        ...(scope.teamId === undefined ? {} : { teamId: scope.teamId }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(call?.actor ? { createdBy: call.actor.id } : {}),
      });
      const result = await store.insertAssignment(record);
      await internals.invalidateSubject(subjectId);
      if (result.created) {
        await recordAudit('rbac.assignment.granted', call, {
          resource: { type: 'rbac_assignment', id: result.record.id },
          changes: { after: result.record },
          ...(scope.orgId === undefined ? {} : { tenantId: scope.orgId }),
        });
      }
      return result.record;
    },

    async revokeRole(input, call) {
      await internals.ready();
      const issues = new Issues();
      if (!isRecord(input))
        throw new RbacValidationError('Invalid revoke', [
          { path: '', message: 'must be an object' },
        ]);
      checkUnknownKeys(input, ['id', 'subjectId', 'roleKey', 'scope'], '', issues);

      let existing: AssignmentRecord | undefined;
      if (input.id !== undefined) {
        const id = readIdentifier(input.id, 'id', issues, true);
        issues.throwIfAny('Invalid revoke');
        existing = id ? await store.getAssignment(id) : undefined;
      } else {
        const subjectId = readIdentifier(input.subjectId, 'subjectId', issues, true);
        const roleKey = readPattern(input.roleKey, ROLE_KEY, 'roleKey', issues, true, 'role key');
        const scope = readScope(input.scope, 'scope', issues) ?? {};
        issues.throwIfAny('Invalid revoke');
        if (!subjectId || !roleKey) throw new RbacValidationError('Invalid revoke');
        const page = await store.listAssignments(
          {
            subjectId,
            roleKey,
            orgId: scope.orgId === undefined ? null : scope.orgId,
            teamId: scope.teamId === undefined ? null : scope.teamId,
          },
          { limit: 1 },
        );
        existing = page.items[0];
      }
      if (!existing) {
        throw new RbacNotFoundError('RBAC_ASSIGNMENT_NOT_FOUND', 'Assignment does not exist');
      }
      await store.deleteAssignment(existing.id);
      await internals.invalidateSubject(existing.subjectId);
      await recordAudit('rbac.assignment.revoked', call, {
        resource: { type: 'rbac_assignment', id: existing.id },
        changes: { before: existing },
        ...(existing.orgId === undefined ? {} : { tenantId: existing.orgId }),
      });
      return existing;
    },

    async listAssignments(filter = {}) {
      await internals.ready();
      const issues = new Issues();
      const limit = readLimit(filter.limit, 'limit', issues);
      const subjectId = readIdentifier(filter.subjectId, 'subjectId', issues, false);
      const roleKey =
        filter.roleKey === undefined
          ? undefined
          : readPattern(filter.roleKey, ROLE_KEY, 'roleKey', issues, false, 'role key');
      issues.throwIfAny('Invalid filter');
      return store.listAssignments(
        {
          ...(subjectId === undefined ? {} : { subjectId }),
          ...(roleKey === undefined ? {} : { roleKey }),
          ...(filter.orgId === undefined ? {} : { orgId: filter.orgId }),
          ...(filter.teamId === undefined ? {} : { teamId: filter.teamId }),
        },
        { limit, ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }) },
      );
    },

    async grant(input, call) {
      await internals.ready();
      const issues = new Issues();
      if (!isRecord(input))
        throw new RbacValidationError('Invalid grant', [
          { path: '', message: 'must be an object' },
        ]);
      checkUnknownKeys(
        input,
        [
          'subjectId',
          'roleKey',
          'resourceType',
          'resourceId',
          'orgId',
          'permissions',
          'effect',
          'expiresAt',
        ],
        '',
        issues,
      );
      const subjectId = readIdentifier(input.subjectId, 'subjectId', issues, false);
      const roleKey =
        input.roleKey === undefined
          ? undefined
          : readPattern(input.roleKey, ROLE_KEY, 'roleKey', issues, false, 'role key');
      if ((subjectId === undefined) === (roleKey === undefined)) {
        issues.add('subjectId', 'exactly one of subjectId and roleKey is required');
      }
      const resourceType = readPattern(
        input.resourceType,
        RESOURCE_TYPE,
        'resourceType',
        issues,
        true,
        'resource type',
      );
      const resourceId = readIdentifier(input.resourceId, 'resourceId', issues, true);
      const orgId = readIdentifier(input.orgId, 'orgId', issues, false);
      const permissions = readPermissionList(input.permissions, 'permissions', issues, {
        required: true,
        nonEmpty: true,
        max: 100,
      });
      let effect: Effect = 'allow';
      if (input.effect === undefined) {
        effect = 'allow';
      } else if (input.effect === 'allow' || input.effect === 'deny') {
        effect = input.effect;
      } else {
        issues.add('effect', 'must be allow or deny');
      }
      const expiresAt = readTimestamp(input.expiresAt, 'expiresAt', issues);
      issues.throwIfAny('Invalid grant');
      if (!resourceType || !resourceId || !permissions)
        throw new RbacValidationError('Invalid grant');

      if (roleKey) {
        const role = await store.getRole(roleKey);
        if (!role) throw new RbacRoleNotFoundError(roleKey);
      }
      await assertRegistered(permissions, 'permissions');
      if (effect === 'allow') {
        await assertNoEscalation(call?.actor, permissions, makeScope(orgId, undefined));
      }

      const now = clock.now();
      const record: GrantRecord = freezeRecord({
        id: generateId(),
        resourceType,
        resourceId,
        permissions: Object.freeze([...permissions]),
        effect,
        createdAt: now,
        ...(subjectId === undefined ? {} : { subjectId }),
        ...(roleKey === undefined ? {} : { roleKey }),
        ...(orgId === undefined ? {} : { orgId }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(call?.actor ? { createdBy: call.actor.id } : {}),
      });
      await store.insertGrant(record);
      if (subjectId) await internals.invalidateSubject(subjectId);
      await recordAudit('rbac.grant.created', call, {
        resource: { type: 'rbac_grant', id: record.id },
        changes: { after: record },
        ...(orgId === undefined ? {} : { tenantId: orgId }),
      });
      return record;
    },

    async revokeGrant(id, call) {
      await internals.ready();
      const existing = await store.getGrant(id);
      if (!existing)
        throw new RbacNotFoundError('RBAC_GRANT_NOT_FOUND', `Grant "${id}" does not exist`);
      await store.deleteGrant(id);
      if (existing.subjectId) await internals.invalidateSubject(existing.subjectId);
      await recordAudit('rbac.grant.revoked', call, {
        resource: { type: 'rbac_grant', id },
        changes: { before: existing },
        ...(existing.orgId === undefined ? {} : { tenantId: existing.orgId }),
      });
      return existing;
    },

    async listGrants(filter = {}) {
      await internals.ready();
      const issues = new Issues();
      const limit = readLimit(filter.limit, 'limit', issues);
      const subjectId = readIdentifier(filter.subjectId, 'subjectId', issues, false);
      const roleKey =
        filter.roleKey === undefined
          ? undefined
          : readPattern(filter.roleKey, ROLE_KEY, 'roleKey', issues, false, 'role key');
      const resourceType =
        filter.resourceType === undefined
          ? undefined
          : readPattern(
              filter.resourceType,
              RESOURCE_TYPE,
              'resourceType',
              issues,
              false,
              'resource type',
            );
      const resourceId = readIdentifier(filter.resourceId, 'resourceId', issues, false);
      issues.throwIfAny('Invalid filter');
      return store.listGrants(
        {
          ...(subjectId === undefined ? {} : { subjectId }),
          ...(roleKey === undefined ? {} : { roleKey }),
          ...(resourceType === undefined ? {} : { resourceType }),
          ...(resourceId === undefined ? {} : { resourceId }),
          ...(filter.orgId === undefined ? {} : { orgId: filter.orgId }),
        },
        { limit, ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }) },
      );
    },

    async listOwnershipRules() {
      await internals.ready();
      return store.listOwnershipRules();
    },

    async createOwnershipRule(input, call) {
      await internals.ready();
      const issues = new Issues();
      if (!isRecord(input))
        throw new RbacValidationError('Invalid ownership rule', [
          { path: '', message: 'must be an object' },
        ]);
      checkUnknownKeys(input, ['id', 'resourceType', 'permissions', 'description'], '', issues);
      const id =
        input.id === undefined
          ? `owner:${typeof input.resourceType === 'string' ? input.resourceType : 'unknown'}`
          : readPattern(input.id, RECORD_ID, 'id', issues, true, 'ownership rule id');
      const resourceType =
        input.resourceType === '*'
          ? '*'
          : readPattern(
              input.resourceType,
              RESOURCE_TYPE,
              'resourceType',
              issues,
              true,
              'resource type',
            );
      const permissions = readPermissionList(input.permissions, 'permissions', issues, {
        required: true,
        nonEmpty: true,
        max: 100,
      });
      const description = readText(
        input.description,
        'description',
        issues,
        MAX_DESCRIPTION_LENGTH,
      );
      issues.throwIfAny('Invalid ownership rule');
      if (!id || !resourceType || !permissions)
        throw new RbacValidationError('Invalid ownership rule');
      if (await store.getOwnershipRule(id)) {
        throw new RbacConflictError(`Ownership rule "${id}" already exists`);
      }
      await assertRegistered(permissions, 'permissions');
      await assertNoEscalation(call?.actor, permissions, {});
      const now = clock.now();
      const record: OwnershipRuleRecord = freezeRecord({
        id,
        resourceType,
        permissions: Object.freeze([...permissions]),
        system: false,
        createdAt: now,
        updatedAt: now,
        ...(description === undefined ? {} : { description }),
      });
      await store.putOwnershipRule(record);
      touchCatalog();
      await recordAudit('rbac.ownership.created', call, {
        resource: { type: 'rbac_ownership_rule', id },
        changes: { after: record },
      });
      return record;
    },

    async updateOwnershipRule(id, input, call) {
      await internals.ready();
      const existing = await store.getOwnershipRule(id);
      if (!existing) {
        throw new RbacNotFoundError(
          'RBAC_OWNERSHIP_RULE_NOT_FOUND',
          `Ownership rule "${id}" does not exist`,
        );
      }
      if (existing.system)
        throw new RbacImmutableError(`System ownership rule "${id}" cannot be changed`);
      const issues = new Issues();
      if (!isRecord(input))
        throw new RbacValidationError('Invalid ownership rule', [
          { path: '', message: 'must be an object' },
        ]);
      checkUnknownKeys(input, ['permissions', 'description'], '', issues);
      const permissions =
        input.permissions === undefined
          ? [...existing.permissions]
          : (readPermissionList(input.permissions, 'permissions', issues, {
              required: true,
              nonEmpty: true,
              max: 100,
            }) ?? []);
      let description: string | undefined = existing.description;
      if (input.description === null) description = undefined;
      else if (input.description !== undefined) {
        description = readText(input.description, 'description', issues, MAX_DESCRIPTION_LENGTH);
      }
      issues.throwIfAny('Invalid ownership rule');
      const added = permissions.filter((p) => !existing.permissions.includes(p));
      await assertRegistered(added, 'permissions');
      await assertNoEscalation(call?.actor, added, {});
      const stored: OwnershipRuleRecord = freezeRecord({
        id: existing.id,
        resourceType: existing.resourceType,
        permissions: Object.freeze(permissions),
        system: existing.system,
        createdAt: existing.createdAt,
        updatedAt: clock.now(),
        ...(description === undefined ? {} : { description }),
      });
      await store.putOwnershipRule(stored);
      touchCatalog();
      await recordAudit('rbac.ownership.updated', call, {
        resource: { type: 'rbac_ownership_rule', id },
        changes: { before: existing, after: stored },
      });
      return stored;
    },

    async deleteOwnershipRule(id, options = {}) {
      await internals.ready();
      const existing = await store.getOwnershipRule(id);
      if (!existing) {
        throw new RbacNotFoundError(
          'RBAC_OWNERSHIP_RULE_NOT_FOUND',
          `Ownership rule "${id}" does not exist`,
        );
      }
      if (existing.system && !options.force) {
        throw new RbacImmutableError(`System ownership rule "${id}" cannot be deleted`);
      }
      if (existing.system && options.force) {
        throw new RbacImmutableError(`System ownership rule "${id}" cannot be deleted`);
      }
      await store.deleteOwnershipRule(id);
      touchCatalog();
      await recordAudit('rbac.ownership.deleted', options, {
        resource: { type: 'rbac_ownership_rule', id },
        changes: { before: existing },
      });
    },

    async listPolicies() {
      await internals.ready();
      return store.listPolicies();
    },

    async createPolicy(input, call) {
      await internals.ready();
      const issues = new Issues();
      const normalised = readPolicyInput(input, '', issues, { requireId: false });
      issues.throwIfAny('Invalid policy');
      if (!normalised) throw new RbacValidationError('Invalid policy');
      const id = normalised.id || generateId();
      if (await store.getPolicy(id)) throw new RbacConflictError(`Policy "${id}" already exists`);
      await assertRegistered(normalised.permissions, 'permissions');
      if (normalised.effect === 'allow') {
        await assertNoEscalation(call?.actor, normalised.permissions, {});
      }
      if (normalised.roles) {
        for (const role of normalised.roles) {
          if (!(await store.getRole(role))) throw new RbacRoleNotFoundError(role);
        }
      }
      const now = clock.now();
      const record: PolicyRecord = freezeRecord({
        id,
        effect: normalised.effect,
        permissions: normalised.permissions,
        condition: normalised.condition,
        system: false,
        createdAt: now,
        updatedAt: now,
        ...(normalised.description === undefined ? {} : { description: normalised.description }),
        ...(normalised.resourceTypes === undefined
          ? {}
          : { resourceTypes: normalised.resourceTypes }),
        ...(normalised.roles === undefined ? {} : { roles: normalised.roles }),
      });
      await store.putPolicy(record);
      touchCatalog();
      await recordAudit('rbac.policy.created', call, {
        resource: { type: 'rbac_policy', id },
        changes: { after: record },
      });
      return record;
    },

    async updatePolicy(id, input, call) {
      await internals.ready();
      const existing = await store.getPolicy(id);
      if (!existing)
        throw new RbacNotFoundError('RBAC_POLICY_NOT_FOUND', `Policy "${id}" does not exist`);
      if (existing.system) throw new RbacImmutableError(`System policy "${id}" cannot be changed`);
      const issues = new Issues();
      if (!isRecord(input))
        throw new RbacValidationError('Invalid policy', [
          { path: '', message: 'must be an object' },
        ]);
      const merged = {
        id,
        description:
          input.description === null ? undefined : (input.description ?? existing.description),
        effect: input.effect ?? existing.effect,
        permissions: input.permissions ?? existing.permissions,
        resourceTypes:
          input.resourceTypes === null
            ? undefined
            : (input.resourceTypes ?? existing.resourceTypes),
        roles: input.roles === null ? undefined : (input.roles ?? existing.roles),
        condition: input.condition ?? existing.condition,
      };
      const normalised = readPolicyInput(merged, '', issues, { requireId: true });
      issues.throwIfAny('Invalid policy');
      if (!normalised) throw new RbacValidationError('Invalid policy');
      const added = normalised.permissions.filter((p) => !existing.permissions.includes(p));
      await assertRegistered(added, 'permissions');
      if (normalised.effect === 'allow') {
        await assertNoEscalation(call?.actor, added, {});
      }
      if (normalised.roles) {
        for (const role of normalised.roles) {
          if (!(await store.getRole(role))) throw new RbacRoleNotFoundError(role);
        }
      }
      const record: PolicyRecord = freezeRecord({
        id,
        effect: normalised.effect,
        permissions: normalised.permissions,
        condition: normalised.condition,
        system: false,
        createdAt: existing.createdAt,
        updatedAt: clock.now(),
        ...(normalised.description === undefined ? {} : { description: normalised.description }),
        ...(normalised.resourceTypes === undefined
          ? {}
          : { resourceTypes: normalised.resourceTypes }),
        ...(normalised.roles === undefined ? {} : { roles: normalised.roles }),
      });
      await store.putPolicy(record);
      touchCatalog();
      await recordAudit('rbac.policy.updated', call, {
        resource: { type: 'rbac_policy', id },
        changes: { before: existing, after: record },
      });
      return record;
    },

    async deletePolicy(id, options = {}) {
      await internals.ready();
      const existing = await store.getPolicy(id);
      if (!existing)
        throw new RbacNotFoundError('RBAC_POLICY_NOT_FOUND', `Policy "${id}" does not exist`);
      if (existing.system) throw new RbacImmutableError(`System policy "${id}" cannot be deleted`);
      await store.deletePolicy(id);
      touchCatalog();
      await recordAudit('rbac.policy.deleted', options, {
        resource: { type: 'rbac_policy', id },
        changes: { before: existing },
      });
    },

    async purgeExpired(call) {
      await internals.ready();
      const result = await store.deleteExpired(clock.now());
      if (result.assignments + result.grants > 0) {
        await internals.bumpGeneration();
      }
      await recordAudit('rbac.expired.purged', call, { metadata: result });
      return result;
    },
  };

  return admin;
}
