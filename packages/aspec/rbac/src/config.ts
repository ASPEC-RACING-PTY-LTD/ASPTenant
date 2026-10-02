import { findCycle } from './catalog.js';
import { type PolicyCondition, validateCondition } from './conditions.js';
import { RbacConfigError, RbacConflictError, RbacInvalidPolicyError } from './errors.js';
import { parsePermission, permissionCovers } from './permissions.js';
import type { LoggerLike } from './ports.js';
import type { RbacStore } from './store.js';
import type {
  Effect,
  OwnershipRuleRecord,
  PermissionRecord,
  PolicyRecord,
  RoleRecord,
  ScopeKind,
} from './types.js';
import { SCOPE_KINDS } from './types.js';
import {
  checkUnknownKeys,
  Issues,
  isRecord,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  RECORD_ID,
  RESOURCE_TYPE,
  ROLE_KEY,
  readKeyList,
  readPattern,
  readPermissionList,
  readScopeKinds,
  readText,
} from './validate.js';

export interface PermissionDefinition {
  key: string;
  description?: string;
}

export interface RoleDefinition {
  key: string;
  name?: string;
  description?: string;
  permissions?: readonly string[];
  denies?: readonly string[];
  parents?: readonly string[];
  /** Default: every scope kind. */
  assignableScopes?: readonly ScopeKind[];
}

export interface OwnershipDefinition {
  /** Default `owner:<resourceType>`. */
  id?: string;
  /** Resource type or `*`. */
  resourceType: string;
  permissions: readonly string[];
  description?: string;
}

export interface PolicyDefinition {
  id: string;
  description?: string;
  effect: Effect;
  permissions: readonly string[];
  resourceTypes?: readonly string[];
  roles?: readonly string[];
  condition: PolicyCondition;
}

export interface RbacDefinitionInput {
  permissions?: readonly (string | PermissionDefinition)[];
  roles?: readonly RoleDefinition[];
  ownership?: readonly OwnershipDefinition[];
  policies?: readonly PolicyDefinition[];
}

export interface NormalisedRoleDefinition {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly permissions: readonly string[];
  readonly denies: readonly string[];
  readonly parents: readonly string[];
  readonly assignableScopes: readonly ScopeKind[];
}

export interface NormalisedOwnershipDefinition {
  readonly id: string;
  readonly resourceType: string;
  readonly permissions: readonly string[];
  readonly description?: string;
}

export interface NormalisedPolicyDefinition {
  readonly id: string;
  readonly description?: string;
  readonly effect: Effect;
  readonly permissions: readonly string[];
  readonly resourceTypes?: readonly string[];
  readonly roles?: readonly string[];
  readonly condition: PolicyCondition;
}

/** A validated, frozen definition produced by defineRbac or loadRbacConfig. */
export interface RbacDefinition {
  readonly permissions: readonly PermissionDefinition[];
  readonly roles: readonly NormalisedRoleDefinition[];
  readonly ownership: readonly NormalisedOwnershipDefinition[];
  readonly policies: readonly NormalisedPolicyDefinition[];
}

/** Permission always treated as registered in definitions (the default admin permission). */
export const DEFAULT_ADMIN_PERMISSION = 'rbac:admin';

const validated = new WeakSet<object>();

/** True for definitions returned by defineRbac or loadRbacConfig. */
export function isRbacDefinition(value: unknown): value is RbacDefinition {
  return typeof value === 'object' && value !== null && validated.has(value);
}

/**
 * True when a pattern refers to at least one registered permission: a concrete permission
 * must be registered, a wildcard must be `*:*` or cover a registered permission.
 */
export function patternIsRegistered(pattern: string, registered: ReadonlySet<string>): boolean {
  const p = parsePermission(pattern);
  if (!p.wildcard) return registered.has(p.key);
  if (p.resource === '*' && p.action === '*') return true;
  for (const key of registered) if (permissionCovers(p.key, key)) return true;
  return false;
}

function fail(issues: Issues, what: string): never {
  const first = issues.list[0];
  throw new RbacConfigError(
    `Invalid RBAC ${what}${first ? `: ${first.path} ${first.message}` : ''}`,
    issues.list,
  );
}

function checkRegistered(
  list: readonly string[] | undefined,
  path: string,
  registered: ReadonlySet<string> | undefined,
  issues: Issues,
): void {
  if (!list || !registered) return;
  list.forEach((pattern, index) => {
    if (!patternIsRegistered(pattern, registered)) {
      issues.add(`${path}.${index}`, `permission "${pattern}" is not registered in permissions`);
    }
  });
}

function validateDefinition(input: unknown, base: string, issues: Issues): RbacDefinition {
  const root = isRecord(input) ? input : {};
  if (!isRecord(input)) issues.add(base || 'definition', 'must be an object');
  const at = (p: string) => (base ? `${base}.${p}` : p);

  const permissions: PermissionDefinition[] = [];
  const permissionKeys = new Set<string>();
  const rawPermissions = root.permissions ?? [];
  if (!Array.isArray(rawPermissions)) issues.add(at('permissions'), 'must be an array');
  else {
    rawPermissions.forEach((item: unknown, index) => {
      const path = at(`permissions.${index}`);
      const entry = typeof item === 'string' ? { key: item } : item;
      if (!isRecord(entry)) {
        issues.add(path, 'must be a permission string or { key, description }');
        return;
      }
      checkUnknownKeys(entry, ['key', 'description'], path, issues);
      const keyList = readPermissionList([entry.key], `${path}.key`, issues, {
        allowWildcards: false,
      });
      const key = keyList?.[0];
      const description = readText(
        entry.description,
        `${path}.description`,
        issues,
        MAX_DESCRIPTION_LENGTH,
      );
      if (key === undefined) return;
      if (permissionKeys.has(key)) {
        issues.add(`${path}.key`, `duplicate permission "${key}"`);
        return;
      }
      permissionKeys.add(key);
      permissions.push(description === undefined ? { key } : { key, description });
    });
  }
  const registered =
    permissionKeys.size > 0 ? new Set([...permissionKeys, DEFAULT_ADMIN_PERMISSION]) : undefined;

  const roles: NormalisedRoleDefinition[] = [];
  const rawRoles = root.roles ?? [];
  const roleKeys = new Set<string>();
  if (!Array.isArray(rawRoles)) issues.add(at('roles'), 'must be an array');
  else {
    for (const [index, item] of rawRoles.entries()) {
      const k = isRecord(item) ? item.key : undefined;
      if (typeof k === 'string' && ROLE_KEY.test(k)) {
        if (roleKeys.has(k)) issues.add(at(`roles.${index}.key`), `duplicate role "${k}"`);
        roleKeys.add(k);
      }
    }
    rawRoles.forEach((item: unknown, index) => {
      const path = at(`roles.${index}`);
      if (!isRecord(item)) {
        issues.add(path, 'must be an object');
        return;
      }
      checkUnknownKeys(
        item,
        ['key', 'name', 'description', 'permissions', 'denies', 'parents', 'assignableScopes'],
        path,
        issues,
      );
      const key = readPattern(item.key, ROLE_KEY, `${path}.key`, issues, true, 'role key');
      const name = readText(item.name, `${path}.name`, issues, MAX_NAME_LENGTH);
      const description = readText(
        item.description,
        `${path}.description`,
        issues,
        MAX_DESCRIPTION_LENGTH,
      );
      const perms = readPermissionList(item.permissions ?? [], `${path}.permissions`, issues);
      const denies = readPermissionList(item.denies ?? [], `${path}.denies`, issues);
      const parents =
        readKeyList(item.parents, ROLE_KEY, `${path}.parents`, issues, 'role key') ?? [];
      parents.forEach((parent, i) => {
        if (!roleKeys.has(parent)) {
          issues.add(`${path}.parents.${i}`, `parent role "${parent}" is not defined`);
        }
      });
      const scopes = readScopeKinds(item.assignableScopes, `${path}.assignableScopes`, issues);
      checkRegistered(perms, `${path}.permissions`, registered, issues);
      checkRegistered(denies, `${path}.denies`, registered, issues);
      if (key === undefined || perms === undefined || denies === undefined) return;
      const role: NormalisedRoleDefinition = {
        key,
        name: name ?? key,
        permissions: Object.freeze(perms),
        denies: Object.freeze(denies),
        parents: Object.freeze(parents),
        assignableScopes: Object.freeze(scopes ?? [...SCOPE_KINDS]),
        ...(description === undefined ? {} : { description }),
      };
      roles.push(Object.freeze(role));
    });
    const graph = new Map(roles.map((r) => [r.key, r.parents]));
    const cycle = findCycle(graph);
    if (cycle) issues.add(at('roles'), `role hierarchy cycle: ${cycle.join(' -> ')}`);
  }

  const ownership: NormalisedOwnershipDefinition[] = [];
  const ownershipIds = new Set<string>();
  const rawOwnership = root.ownership ?? [];
  if (!Array.isArray(rawOwnership)) issues.add(at('ownership'), 'must be an array');
  else {
    rawOwnership.forEach((item: unknown, index) => {
      const path = at(`ownership.${index}`);
      if (!isRecord(item)) {
        issues.add(path, 'must be an object');
        return;
      }
      checkUnknownKeys(item, ['id', 'resourceType', 'permissions', 'description'], path, issues);
      const resourceType =
        item.resourceType === '*'
          ? '*'
          : readPattern(
              item.resourceType,
              RESOURCE_TYPE,
              `${path}.resourceType`,
              issues,
              true,
              'resource type',
            );
      const perms = readPermissionList(item.permissions, `${path}.permissions`, issues, {
        required: true,
        nonEmpty: true,
      });
      const description = readText(
        item.description,
        `${path}.description`,
        issues,
        MAX_DESCRIPTION_LENGTH,
      );
      checkRegistered(perms, `${path}.permissions`, registered, issues);
      const id =
        item.id === undefined
          ? resourceType === undefined
            ? undefined
            : `owner:${resourceType}`
          : readPattern(item.id, RECORD_ID, `${path}.id`, issues, true, 'ownership rule id');
      if (id === undefined || resourceType === undefined || perms === undefined) return;
      if (ownershipIds.has(id)) {
        issues.add(`${path}.id`, `duplicate ownership rule id "${id}"`);
        return;
      }
      ownershipIds.add(id);
      ownership.push(
        Object.freeze({
          id,
          resourceType,
          permissions: Object.freeze(perms),
          ...(description === undefined ? {} : { description }),
        }),
      );
    });
  }

  const policies: NormalisedPolicyDefinition[] = [];
  const policyIds = new Set<string>();
  const rawPolicies = root.policies ?? [];
  if (!Array.isArray(rawPolicies)) issues.add(at('policies'), 'must be an array');
  else {
    rawPolicies.forEach((item: unknown, index) => {
      const path = at(`policies.${index}`);
      const policy = readPolicyInput(item, path, issues, { requireId: true });
      if (!policy) return;
      checkRegistered(policy.permissions, `${path}.permissions`, registered, issues);
      policy.roles?.forEach((role, i) => {
        if (!roleKeys.has(role)) issues.add(`${path}.roles.${i}`, `role "${role}" is not defined`);
      });
      if (policyIds.has(policy.id)) {
        issues.add(`${path}.id`, `duplicate policy id "${policy.id}"`);
        return;
      }
      policyIds.add(policy.id);
      policies.push(policy);
    });
  }

  return {
    permissions: Object.freeze(permissions.map((p) => Object.freeze(p))),
    roles: Object.freeze(roles),
    ownership: Object.freeze(ownership),
    policies: Object.freeze(policies),
  };
}

/**
 * Validates a policy object (definition or admin input). Returns undefined and records issues
 * when invalid. With `requireId: false` the id may be omitted (it is then an empty string).
 */
export function readPolicyInput(
  item: unknown,
  path: string,
  issues: Issues,
  options: { requireId: boolean; partial?: boolean },
): NormalisedPolicyDefinition | undefined {
  if (!isRecord(item)) {
    issues.add(path, 'must be an object');
    return undefined;
  }
  checkUnknownKeys(
    item,
    ['id', 'description', 'effect', 'permissions', 'resourceTypes', 'roles', 'condition'],
    path,
    issues,
  );
  const id =
    item.id === undefined && !options.requireId
      ? ''
      : readPattern(item.id, RECORD_ID, `${path}.id`, issues, true, 'policy id');
  const description = readText(
    item.description,
    `${path}.description`,
    issues,
    MAX_DESCRIPTION_LENGTH,
  );
  const effect = item.effect;
  if (effect !== 'allow' && effect !== 'deny')
    issues.add(`${path}.effect`, 'must be allow or deny');
  const perms = readPermissionList(item.permissions, `${path}.permissions`, issues, {
    required: true,
    nonEmpty: true,
    max: 100,
  });
  const resourceTypes = readKeyList(
    item.resourceTypes,
    RESOURCE_TYPE,
    `${path}.resourceTypes`,
    issues,
    'resource type',
  );
  const roles = readKeyList(item.roles, ROLE_KEY, `${path}.roles`, issues, 'role key');
  if (resourceTypes && resourceTypes.length === 0)
    issues.add(`${path}.resourceTypes`, 'must not be empty');
  if (roles && roles.length === 0) issues.add(`${path}.roles`, 'must not be empty');
  let condition: PolicyCondition | undefined;
  if (item.condition === undefined) issues.add(`${path}.condition`, 'is required');
  else {
    try {
      condition = validateCondition(item.condition);
    } catch (err) {
      if (!(err instanceof RbacInvalidPolicyError)) throw err;
      const details = err.details as { issues: { path: string; message: string }[] };
      for (const issue of details.issues) issues.add(`${path}.${issue.path}`, issue.message);
    }
  }
  if (
    id === undefined ||
    perms === undefined ||
    condition === undefined ||
    (effect !== 'allow' && effect !== 'deny')
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    effect,
    permissions: Object.freeze(perms),
    condition,
    ...(description === undefined ? {} : { description }),
    ...(resourceTypes === undefined ? {} : { resourceTypes: Object.freeze(resourceTypes) }),
    ...(roles === undefined ? {} : { roles: Object.freeze(roles) }),
  });
}

/**
 * Validates a code-defined RBAC definition. Throws RbacConfigError naming the first invalid
 * path (all issues are in `error.issues`). The result is frozen and can be passed to createRbac.
 */
export function defineRbac(input: RbacDefinitionInput): RbacDefinition {
  if (isRbacDefinition(input)) return input;
  const issues = new Issues();
  const definition = validateDefinition(input, '', issues);
  if (!issues.empty) fail(issues, 'definition');
  const frozen = Object.freeze(definition);
  validated.add(frozen);
  return frozen;
}

/** Serialisable engine options accepted in the JSON configuration form. */
export interface RbacConfigOptions {
  adminPermission?: string;
  adminReadPermission?: string;
  orgRolesApplyToTeams?: boolean;
  staticRoles?: 'auto' | 'global' | 'ignore';
  catalogTtlMs?: number;
  cacheTtlMs?: number;
  cacheKeyPrefix?: string;
  auditDenied?: boolean | { sampleRate: number };
  requireRegisteredPermissions?: boolean;
  preventEscalation?: boolean;
  timeZone?: string;
}

export interface LoadedRbacConfig {
  definition: RbacDefinition;
  options: RbacConfigOptions;
  sql: { tablePrefix?: string };
}

const OPTION_KEYS = [
  'adminPermission',
  'adminReadPermission',
  'orgRolesApplyToTeams',
  'staticRoles',
  'catalogTtlMs',
  'cacheTtlMs',
  'cacheKeyPrefix',
  'auditDenied',
  'requireRegisteredPermissions',
  'preventEscalation',
  'timeZone',
] as const;

/**
 * Validates the JSON configuration form (see config.schema.json): definition entries plus
 * `options` and `sql`. Throws RbacConfigError.
 */
export function loadRbacConfig(json: unknown): LoadedRbacConfig {
  const issues = new Issues();
  if (!isRecord(json)) {
    issues.add('config', 'must be an object');
    fail(issues, 'configuration');
  }
  checkUnknownKeys(
    json,
    ['$schema', 'permissions', 'roles', 'ownership', 'policies', 'options', 'sql'],
    '',
    issues,
  );
  const { options: rawOptions, sql: rawSql, $schema: _schema, ...definitionInput } = json;
  const definition = validateDefinition(definitionInput, '', issues);
  const options: RbacConfigOptions = {};
  if (rawOptions !== undefined) {
    if (!isRecord(rawOptions)) issues.add('options', 'must be an object');
    else {
      checkUnknownKeys(rawOptions, OPTION_KEYS, 'options', issues);
      Object.assign(options, readOptions(rawOptions, issues));
    }
  }
  const sql: { tablePrefix?: string } = {};
  if (rawSql !== undefined) {
    if (!isRecord(rawSql)) issues.add('sql', 'must be an object');
    else {
      checkUnknownKeys(rawSql, ['tablePrefix'], 'sql', issues);
      const prefix = readPattern(
        rawSql.tablePrefix,
        /^[a-z][a-z0-9_]{0,30}$/,
        'sql.tablePrefix',
        issues,
        false,
        'table prefix',
      );
      if (prefix !== undefined) sql.tablePrefix = prefix;
    }
  }
  if (!issues.empty) fail(issues, 'configuration');
  const frozen = Object.freeze(definition);
  validated.add(frozen);
  return { definition: frozen, options, sql };
}

function readOptions(raw: Record<string, unknown>, issues: Issues): RbacConfigOptions {
  const out: RbacConfigOptions = {};
  for (const key of ['adminPermission', 'adminReadPermission'] as const) {
    if (raw[key] === undefined) continue;
    const list = readPermissionList([raw[key]], `options.${key}`, issues, {
      allowWildcards: false,
    });
    if (list?.[0]) out[key] = list[0];
  }
  for (const key of [
    'orgRolesApplyToTeams',
    'requireRegisteredPermissions',
    'preventEscalation',
  ] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') issues.add(`options.${key}`, 'must be a boolean');
    else out[key] = raw[key];
  }
  if (raw.staticRoles !== undefined) {
    if (
      raw.staticRoles !== 'auto' &&
      raw.staticRoles !== 'global' &&
      raw.staticRoles !== 'ignore'
    ) {
      issues.add('options.staticRoles', 'must be auto, global or ignore');
    } else out.staticRoles = raw.staticRoles;
  }
  for (const key of ['catalogTtlMs', 'cacheTtlMs'] as const) {
    if (raw[key] === undefined) continue;
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      issues.add(`options.${key}`, 'must be a non-negative integer');
    } else out[key] = v;
  }
  if (raw.cacheKeyPrefix !== undefined) {
    const v = readText(raw.cacheKeyPrefix, 'options.cacheKeyPrefix', issues, 64, true);
    if (v !== undefined) out.cacheKeyPrefix = v;
  }
  if (raw.timeZone !== undefined) {
    const v = readText(raw.timeZone, 'options.timeZone', issues, 64, true);
    if (v !== undefined) {
      if (!isValidTimeZone(v)) issues.add('options.timeZone', 'must be an IANA time zone');
      else out.timeZone = v;
    }
  }
  if (raw.auditDenied !== undefined) {
    const v = raw.auditDenied;
    if (typeof v === 'boolean') out.auditDenied = v;
    else if (
      isRecord(v) &&
      typeof v.sampleRate === 'number' &&
      v.sampleRate >= 0 &&
      v.sampleRate <= 1
    ) {
      out.auditDenied = { sampleRate: v.sampleRate };
    } else issues.add('options.auditDenied', 'must be a boolean or { sampleRate: 0..1 }');
  }
  return out;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export interface SeedOptions {
  now: number;
  /** Permissions registered as system entries in addition to the definition. */
  builtInPermissions: readonly PermissionDefinition[];
  /** Remove (or demote, for roles in use) system entries that are no longer defined. */
  prune: boolean;
  logger: LoggerLike;
}

export interface SeedResult {
  created: number;
  updated: number;
  removed: number;
  demoted: number;
}

/** JSON with object keys sorted, so values read back from JSONB compare equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Writes a definition into the store as system entries. Idempotent: unchanged entries are not
 * written. Runs in one store transaction and serialises role changes with the roles revision.
 */
export async function seedDefinition(
  store: RbacStore,
  definition: RbacDefinition,
  options: SeedOptions,
): Promise<SeedResult> {
  return store.transaction(async (tx) => {
    const result: SeedResult = { created: 0, updated: 0, removed: 0, demoted: 0 };
    const now = options.now;
    const revision = await tx.getRolesRevision();

    const wantedPermissions = new Map<string, PermissionDefinition>();
    for (const p of options.builtInPermissions) wantedPermissions.set(p.key, p);
    for (const p of definition.permissions) wantedPermissions.set(p.key, p);
    const existingPermissions = new Map((await tx.listPermissions()).map((p) => [p.key, p]));
    for (const [key, def] of wantedPermissions) {
      const current = existingPermissions.get(key);
      if (current?.system && current.description === def.description) continue;
      const record: PermissionRecord = {
        key,
        system: true,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        ...(def.description === undefined ? {} : { description: def.description }),
      };
      await tx.putPermission(record);
      if (current) result.updated++;
      else result.created++;
    }

    const existingRoles = await tx.listRoles();
    const roleMap = new Map(existingRoles.map((r) => [r.key, r]));
    let rolesChanged = false;
    for (const def of definition.roles) {
      const current = roleMap.get(def.key);
      const fields = {
        name: def.name,
        permissions: def.permissions,
        denies: def.denies,
        parents: def.parents,
        assignableScopes: def.assignableScopes,
        ...(def.description === undefined ? {} : { description: def.description }),
      };
      if (!current) {
        const record: RoleRecord = {
          key: def.key,
          ...fields,
          system: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        if (!(await tx.insertRole(record)))
          throw new RbacConflictError(`Role "${def.key}" was created concurrently`);
        result.created++;
        rolesChanged = true;
        continue;
      }
      const same =
        current.system &&
        current.name === fields.name &&
        current.description === def.description &&
        sameJson(current.permissions, fields.permissions) &&
        sameJson(current.denies, fields.denies) &&
        sameJson(current.parents, fields.parents) &&
        sameJson(current.assignableScopes, fields.assignableScopes);
      if (same) continue;
      if (!current.system) {
        options.logger.warn(
          { role: def.key },
          'rbac: custom role replaced by a system role of the same key',
        );
      }
      const record: RoleRecord = {
        key: def.key,
        ...fields,
        system: true,
        version: current.version + 1,
        createdAt: current.createdAt,
        updatedAt: now,
      };
      if (!(await tx.updateRole(record, current.version))) {
        throw new RbacConflictError(`Role "${def.key}" was modified concurrently`);
      }
      roleMap.set(def.key, record);
      result.updated++;
      rolesChanged = true;
    }

    const existingOwnership = new Map((await tx.listOwnershipRules()).map((r) => [r.id, r]));
    for (const def of definition.ownership) {
      const current = existingOwnership.get(def.id);
      if (
        current?.system &&
        current.resourceType === def.resourceType &&
        current.description === def.description &&
        sameJson(current.permissions, def.permissions)
      ) {
        continue;
      }
      const record: OwnershipRuleRecord = {
        id: def.id,
        resourceType: def.resourceType,
        permissions: def.permissions,
        system: true,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        ...(def.description === undefined ? {} : { description: def.description }),
      };
      await tx.putOwnershipRule(record);
      if (current) result.updated++;
      else result.created++;
    }

    const existingPolicies = new Map((await tx.listPolicies()).map((p) => [p.id, p]));
    for (const def of definition.policies) {
      const current = existingPolicies.get(def.id);
      const record: PolicyRecord = {
        ...def,
        system: true,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      if (
        current?.system &&
        sameJson(
          { ...current, createdAt: 0, updatedAt: 0 },
          { ...record, createdAt: 0, updatedAt: 0 },
        )
      ) {
        continue;
      }
      await tx.putPolicy(record);
      if (current) result.updated++;
      else result.created++;
    }

    if (options.prune) {
      for (const [key, current] of existingPermissions) {
        if (current.system && !wantedPermissions.has(key)) {
          await tx.deletePermission(key);
          result.removed++;
        }
      }
      for (const [id, current] of existingOwnership) {
        if (current.system && !definition.ownership.some((o) => o.id === id)) {
          await tx.deleteOwnershipRule(id);
          result.removed++;
        }
      }
      const policies = await tx.listPolicies();
      for (const current of policies) {
        if (current.system && !definition.policies.some((p) => p.id === current.id)) {
          await tx.deletePolicy(current.id);
          result.removed++;
        }
      }
      const definedRoles = new Set(definition.roles.map((r) => r.key));
      const remainingPolicies = await tx.listPolicies();
      for (const current of [...roleMap.values()]) {
        if (!current.system || definedRoles.has(current.key)) continue;
        const inUse =
          (await tx.countAssignments({ roleKey: current.key })) > 0 ||
          (await tx.countGrants({ roleKey: current.key })) > 0 ||
          [...roleMap.values()].some(
            (r) => r.key !== current.key && r.parents.includes(current.key),
          ) ||
          remainingPolicies.some((p) => p.roles?.includes(current.key));
        if (inUse) {
          const record: RoleRecord = {
            ...current,
            system: false,
            version: current.version + 1,
            updatedAt: now,
          };
          if (!(await tx.updateRole(record, current.version))) {
            throw new RbacConflictError(`Role "${current.key}" was modified concurrently`);
          }
          roleMap.set(current.key, record);
          options.logger.warn(
            { role: current.key },
            'rbac: system role removed from the definition is still in use; demoted to a custom role',
          );
          result.demoted++;
        } else {
          await tx.deleteRole(current.key);
          roleMap.delete(current.key);
          result.removed++;
        }
        rolesChanged = true;
      }
    }

    if (rolesChanged) {
      const graph = new Map([...roleMap.values()].map((r) => [r.key, r.parents]));
      const cycle = findCycle(graph);
      if (cycle) {
        throw new RbacConfigError(
          `Seeding would create a role hierarchy cycle: ${cycle.join(' -> ')}`,
          [{ path: 'roles', message: 'cycle with stored custom roles' }],
        );
      }
      if (!(await tx.bumpRolesRevision(revision))) {
        throw new RbacConflictError('Roles were modified concurrently while seeding');
      }
    }
    return result;
  });
}
