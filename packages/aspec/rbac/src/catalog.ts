import {
  type ConditionInput,
  compileCondition,
  conditionUsesTime,
  validateCondition,
} from './conditions.js';
import { createPermissionSet, EMPTY_PERMISSION_SET, type PermissionSet } from './permissions.js';
import type { LoggerLike } from './ports.js';
import type { OwnershipRuleRecord, PermissionRecord, PolicyRecord, RoleRecord } from './types.js';

export type CompiledCondition = (input: ConditionInput) => boolean;

/** Compiles a policy record. Re-validates the condition, so tampered stored data is rejected. */
export function compilePolicy(record: PolicyRecord): CompiledPolicy {
  const condition = validateCondition(record.condition);
  return Object.freeze({
    record,
    permissions: createPermissionSet(record.permissions),
    resourceTypes: record.resourceTypes ? new Set(record.resourceTypes) : undefined,
    roles: record.roles ? new Set(record.roles) : undefined,
    condition: compileCondition(condition),
    usesTime: conditionUsesTime(condition),
  });
}

export interface CompiledRole {
  readonly record: RoleRecord;
  /** The role itself followed by every transitive parent (deduplicated, known roles only). */
  readonly lineage: readonly string[];
  readonly allow: PermissionSet;
  readonly deny: PermissionSet;
}

export interface CompiledOwnership {
  readonly record: OwnershipRuleRecord;
  readonly allow: PermissionSet;
}

export interface CompiledPolicy {
  readonly record: PolicyRecord;
  readonly permissions: PermissionSet;
  readonly resourceTypes: ReadonlySet<string> | undefined;
  readonly roles: ReadonlySet<string> | undefined;
  readonly condition: CompiledCondition;
  readonly usesTime: boolean;
}

export interface MergedRoles {
  /** Effective role keys (assigned roles plus every ancestor). */
  readonly roles: ReadonlySet<string>;
  readonly allow: PermissionSet;
  readonly deny: PermissionSet;
}

export interface Catalog {
  readonly roles: ReadonlyMap<string, CompiledRole>;
  readonly permissions: ReadonlyMap<string, PermissionRecord>;
  readonly ownershipByType: ReadonlyMap<string, readonly CompiledOwnership[]>;
  readonly ownership: readonly CompiledOwnership[];
  readonly policies: readonly CompiledPolicy[];
  readonly denyPolicies: readonly CompiledPolicy[];
  readonly allowPolicies: readonly CompiledPolicy[];
  readonly loadedAt: number;
  /** Merged permission sets for a combination of assigned role keys (memoised, bounded). */
  merged(roleKeys: readonly string[]): MergedRoles;
}

/**
 * Finds a cycle in a role graph. Returns the cycle as a list of keys where the first key is
 * repeated at the end (`[a, b, a]`), or undefined when the graph is acyclic.
 */
export function findCycle(
  graph: ReadonlyMap<string, readonly string[]>,
  start?: Iterable<string>,
): string[] | undefined {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  let found: string[] | undefined;

  const visit = (key: string): boolean => {
    color.set(key, GREY);
    stack.push(key);
    for (const parent of graph.get(key) ?? []) {
      if (!graph.has(parent)) continue;
      const c = color.get(parent) ?? WHITE;
      if (c === GREY) {
        const from = stack.indexOf(parent);
        found = [...stack.slice(from), parent];
        return true;
      }
      if (c === WHITE && visit(parent)) return true;
    }
    stack.pop();
    color.set(key, BLACK);
    return false;
  };

  for (const key of start ?? graph.keys()) {
    if ((color.get(key) ?? WHITE) === WHITE && graph.has(key) && visit(key)) return found;
  }
  return undefined;
}

/** Role key followed by every transitive parent, depth first, ignoring unknown roles and cycles. */
export function lineageOf(key: string, graph: ReadonlyMap<string, readonly string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (k: string) => {
    if (seen.has(k) || !graph.has(k)) return;
    seen.add(k);
    out.push(k);
    for (const parent of graph.get(k) ?? []) walk(parent);
  };
  walk(key);
  return out;
}

const MERGED_CACHE_LIMIT = 2048;

export function buildCatalog(input: {
  roles: readonly RoleRecord[];
  permissions: readonly PermissionRecord[];
  ownership: readonly OwnershipRuleRecord[];
  policies: readonly PolicyRecord[];
  now: number;
  logger: LoggerLike;
}): Catalog {
  const graph = new Map<string, readonly string[]>();
  const records = new Map<string, RoleRecord>();
  for (const role of input.roles) {
    graph.set(role.key, role.parents);
    records.set(role.key, role);
  }
  const cycle = findCycle(graph);
  if (cycle) {
    input.logger.error(
      { cycle },
      'rbac: stored role hierarchy contains a cycle; inheritance along the cycle is truncated',
    );
  }
  const roles = new Map<string, CompiledRole>();
  for (const [key, record] of records) {
    for (const parent of record.parents) {
      if (!records.has(parent)) {
        input.logger.warn({ role: key, parent }, 'rbac: role references an unknown parent');
      }
    }
    const lineage = lineageOf(key, graph);
    const allow: string[] = [];
    const deny: string[] = [];
    for (const k of lineage) {
      const r = records.get(k);
      if (!r) continue;
      allow.push(...r.permissions);
      deny.push(...r.denies);
    }
    roles.set(
      key,
      Object.freeze({
        record,
        lineage: Object.freeze(lineage),
        allow: createPermissionSet(allow),
        deny: deny.length > 0 ? createPermissionSet(deny) : EMPTY_PERMISSION_SET,
      }),
    );
  }

  const ownership: CompiledOwnership[] = [];
  const ownershipByType = new Map<string, CompiledOwnership[]>();
  for (const record of input.ownership) {
    const compiled = Object.freeze({ record, allow: createPermissionSet(record.permissions) });
    ownership.push(compiled);
    const list = ownershipByType.get(record.resourceType) ?? [];
    list.push(compiled);
    ownershipByType.set(record.resourceType, list);
  }

  const policies: CompiledPolicy[] = [];
  for (const record of [...input.policies].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    try {
      policies.push(compilePolicy(record));
    } catch (err) {
      input.logger.error(
        { policy: record.id, err: err instanceof Error ? err.message : String(err) },
        'rbac: stored policy is invalid and was skipped',
      );
    }
  }

  const mergedCache = new Map<string, MergedRoles>();
  const merged = (roleKeys: readonly string[]): MergedRoles => {
    const cacheKey =
      roleKeys.length === 1 ? (roleKeys[0] ?? '') : [...roleKeys].sort().join('\u0000');
    const hit = mergedCache.get(cacheKey);
    if (hit) return hit;
    const effective = new Set<string>();
    const allow: string[] = [];
    const deny: string[] = [];
    let single: CompiledRole | undefined;
    let known = 0;
    for (const key of roleKeys) {
      const role = roles.get(key);
      if (!role) continue;
      known++;
      single = role;
      for (const k of role.lineage) effective.add(k);
      allow.push(...role.allow.patterns());
      deny.push(...role.deny.patterns());
    }
    const result: MergedRoles =
      known === 1 && single
        ? { roles: effective, allow: single.allow, deny: single.deny }
        : {
            roles: effective,
            allow: allow.length > 0 ? createPermissionSet(allow) : EMPTY_PERMISSION_SET,
            deny: deny.length > 0 ? createPermissionSet(deny) : EMPTY_PERMISSION_SET,
          };
    if (mergedCache.size >= MERGED_CACHE_LIMIT) mergedCache.clear();
    mergedCache.set(cacheKey, result);
    return result;
  };

  return {
    roles,
    permissions: new Map(input.permissions.map((p) => [p.key, p])),
    ownershipByType,
    ownership,
    policies,
    denyPolicies: policies.filter((p) => p.record.effect === 'deny'),
    allowPolicies: policies.filter((p) => p.record.effect === 'allow'),
    loadedAt: input.now,
    merged,
  };
}
