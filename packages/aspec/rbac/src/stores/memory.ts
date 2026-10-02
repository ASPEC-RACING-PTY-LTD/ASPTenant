import { RbacLimitError } from '../errors.js';
import type {
  AssignmentFilter,
  GrantFilter,
  GrantLookup,
  PrincipalGrantLookup,
  RbacStore,
  StorePage,
} from '../store.js';
import type {
  AssignmentRecord,
  GrantRecord,
  OwnershipRuleRecord,
  Page,
  PermissionRecord,
  PolicyRecord,
  RoleRecord,
} from '../types.js';

export interface MemoryStoreOptions {
  /**
   * Maximum number of records per collection (permissions, roles, assignments, grants,
   * ownership rules, policies). Inserts beyond it throw RbacLimitError. Default 100000.
   */
  maxRecordsPerCollection?: number;
}

interface State {
  permissions: Map<string, PermissionRecord>;
  roles: Map<string, RoleRecord>;
  assignments: Map<string, AssignmentRecord>;
  grants: Map<string, GrantRecord>;
  ownership: Map<string, OwnershipRuleRecord>;
  policies: Map<string, PolicyRecord>;
  revision: number;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function freezeCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function scopeKey(subjectId: string, roleKey: string, orgId?: string, teamId?: string): string {
  return `${subjectId}\u0000${roleKey}\u0000${orgId ?? ''}\u0000${teamId ?? ''}`;
}

function resourceKey(type: string, id: string): string {
  return `${type}\u0000${id}`;
}

function matchesNullable(value: string | undefined, filter: string | null | undefined): boolean {
  if (filter === undefined) return true;
  if (filter === null) return value === undefined;
  return value === filter;
}

function matchesAssignment(record: AssignmentRecord, filter: AssignmentFilter): boolean {
  return (
    (filter.subjectId === undefined || record.subjectId === filter.subjectId) &&
    (filter.roleKey === undefined || record.roleKey === filter.roleKey) &&
    matchesNullable(record.orgId, filter.orgId) &&
    matchesNullable(record.teamId, filter.teamId)
  );
}

function matchesGrant(record: GrantRecord, filter: GrantFilter): boolean {
  return (
    (filter.subjectId === undefined || record.subjectId === filter.subjectId) &&
    (filter.roleKey === undefined || record.roleKey === filter.roleKey) &&
    (filter.resourceType === undefined || record.resourceType === filter.resourceType) &&
    (filter.resourceId === undefined || record.resourceId === filter.resourceId) &&
    matchesNullable(record.orgId, filter.orgId)
  );
}

function paginate<T extends { id: string }>(
  records: Iterable<T>,
  predicate: (record: T) => boolean,
  page: StorePage,
): Page<T> {
  const matching: T[] = [];
  for (const record of records) {
    if (page.cursor !== undefined && record.id <= page.cursor) continue;
    if (predicate(record)) matching.push(record);
  }
  matching.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const items = matching.slice(0, page.limit);
  const last = items.at(-1);
  return matching.length > page.limit && last ? { items, nextCursor: last.id } : { items };
}

/**
 * In-memory RbacStore for tests, development and single-process applications whose runtime
 * changes need not survive a restart. Transactions snapshot state and restore it on failure.
 */
export function createMemoryStore(options: MemoryStoreOptions = {}): RbacStore {
  const cap = options.maxRecordsPerCollection ?? 100_000;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new RangeError('maxRecordsPerCollection must be a positive integer');
  }
  let state: State = {
    permissions: new Map(),
    roles: new Map(),
    assignments: new Map(),
    grants: new Map(),
    ownership: new Map(),
    policies: new Map(),
    revision: 0,
  };
  let bySubject = new Map<string, Set<string>>();
  let byScopeKey = new Map<string, string>();
  let byResource = new Map<string, Set<string>>();
  let lock: Promise<unknown> = Promise.resolve();

  const rebuildIndexes = () => {
    bySubject = new Map();
    byScopeKey = new Map();
    byResource = new Map();
    for (const a of state.assignments.values()) indexAssignment(a);
    for (const g of state.grants.values()) indexGrant(g);
  };
  const indexAssignment = (a: AssignmentRecord) => {
    let set = bySubject.get(a.subjectId);
    if (!set) {
      set = new Set();
      bySubject.set(a.subjectId, set);
    }
    set.add(a.id);
    byScopeKey.set(scopeKey(a.subjectId, a.roleKey, a.orgId, a.teamId), a.id);
  };
  const unindexAssignment = (a: AssignmentRecord) => {
    const set = bySubject.get(a.subjectId);
    set?.delete(a.id);
    if (set && set.size === 0) bySubject.delete(a.subjectId);
    byScopeKey.delete(scopeKey(a.subjectId, a.roleKey, a.orgId, a.teamId));
  };
  const indexGrant = (g: GrantRecord) => {
    const key = resourceKey(g.resourceType, g.resourceId);
    let set = byResource.get(key);
    if (!set) {
      set = new Set();
      byResource.set(key, set);
    }
    set.add(g.id);
  };
  const unindexGrant = (g: GrantRecord) => {
    const key = resourceKey(g.resourceType, g.resourceId);
    const set = byResource.get(key);
    set?.delete(g.id);
    if (set && set.size === 0) byResource.delete(key);
  };
  const ensureCapacity = (map: Map<string, unknown>, key: string, what: string) => {
    if (!map.has(key) && map.size >= cap) {
      throw new RbacLimitError(`Memory store limit of ${cap} ${what} reached`);
    }
  };

  const store: RbacStore = {
    async listPermissions() {
      return [...state.permissions.values()];
    },
    async getPermission(key) {
      return state.permissions.get(key);
    },
    async putPermission(record) {
      ensureCapacity(state.permissions, record.key, 'permissions');
      state.permissions.set(record.key, freezeCopy(record));
    },
    async deletePermission(key) {
      return state.permissions.delete(key);
    },

    async listRoles() {
      return [...state.roles.values()];
    },
    async getRole(key) {
      return state.roles.get(key);
    },
    async insertRole(record) {
      if (state.roles.has(record.key)) return false;
      ensureCapacity(state.roles, record.key, 'roles');
      state.roles.set(record.key, freezeCopy(record));
      return true;
    },
    async updateRole(record, expectedVersion) {
      const current = state.roles.get(record.key);
      if (!current || current.version !== expectedVersion) return false;
      state.roles.set(record.key, freezeCopy(record));
      return true;
    },
    async deleteRole(key) {
      return state.roles.delete(key);
    },
    async getRolesRevision() {
      return state.revision;
    },
    async bumpRolesRevision(expected) {
      if (state.revision !== expected) return false;
      state.revision++;
      return true;
    },

    async listAssignmentsForSubject(subjectId) {
      const ids = bySubject.get(subjectId);
      if (!ids) return [];
      const out: AssignmentRecord[] = [];
      for (const id of ids) {
        const record = state.assignments.get(id);
        if (record) out.push(record);
      }
      return out;
    },
    async listAssignments(filter, page) {
      if (filter.subjectId !== undefined) {
        const own = await store.listAssignmentsForSubject(filter.subjectId);
        return paginate(own, (a) => matchesAssignment(a, filter), page);
      }
      return paginate(state.assignments.values(), (a) => matchesAssignment(a, filter), page);
    },
    async countAssignments(filter) {
      let n = 0;
      for (const a of state.assignments.values()) if (matchesAssignment(a, filter)) n++;
      return n;
    },
    async getAssignment(id) {
      return state.assignments.get(id);
    },
    async insertAssignment(record) {
      const key = scopeKey(record.subjectId, record.roleKey, record.orgId, record.teamId);
      const existingId = byScopeKey.get(key);
      const existing = existingId === undefined ? undefined : state.assignments.get(existingId);
      if (existing) return { record: existing, created: false };
      ensureCapacity(state.assignments, record.id, 'assignments');
      const stored = freezeCopy(record);
      state.assignments.set(stored.id, stored);
      indexAssignment(stored);
      return { record: stored, created: true };
    },
    async deleteAssignment(id) {
      const record = state.assignments.get(id);
      if (!record) return false;
      state.assignments.delete(id);
      unindexAssignment(record);
      return true;
    },
    async deleteAssignmentsForRole(roleKey) {
      let n = 0;
      for (const record of [...state.assignments.values()]) {
        if (record.roleKey === roleKey) {
          state.assignments.delete(record.id);
          unindexAssignment(record);
          n++;
        }
      }
      return n;
    },

    async findGrants(lookup: GrantLookup) {
      const ids = byResource.get(resourceKey(lookup.resourceType, lookup.resourceId));
      if (!ids) return [];
      const roles = new Set(lookup.roleKeys);
      const out: GrantRecord[] = [];
      for (const id of ids) {
        const g = state.grants.get(id);
        if (!g) continue;
        if (g.subjectId === lookup.subjectId || (g.roleKey !== undefined && roles.has(g.roleKey))) {
          out.push(g);
        }
      }
      return out;
    },
    async listGrantsForPrincipals(lookup: PrincipalGrantLookup) {
      const roles = new Set(lookup.roleKeys);
      const wanted = lookup.resources
        ? new Set(lookup.resources.map((r) => resourceKey(r.type, r.id)))
        : undefined;
      const out: GrantRecord[] = [];
      const sorted = [...state.grants.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const g of sorted) {
        if (out.length >= lookup.limit) break;
        const principal =
          g.subjectId === lookup.subjectId || (g.roleKey !== undefined && roles.has(g.roleKey));
        if (!principal) continue;
        if (wanted && !wanted.has(resourceKey(g.resourceType, g.resourceId))) continue;
        out.push(g);
      }
      return out;
    },
    async listGrants(filter, page) {
      return paginate(state.grants.values(), (g) => matchesGrant(g, filter), page);
    },
    async countGrants(filter) {
      let n = 0;
      for (const g of state.grants.values()) if (matchesGrant(g, filter)) n++;
      return n;
    },
    async getGrant(id) {
      return state.grants.get(id);
    },
    async insertGrant(record) {
      ensureCapacity(state.grants, record.id, 'grants');
      const stored = freezeCopy(record);
      state.grants.set(stored.id, stored);
      indexGrant(stored);
    },
    async deleteGrant(id) {
      const record = state.grants.get(id);
      if (!record) return false;
      state.grants.delete(id);
      unindexGrant(record);
      return true;
    },
    async deleteGrantsForRole(roleKey) {
      let n = 0;
      for (const record of [...state.grants.values()]) {
        if (record.roleKey === roleKey) {
          state.grants.delete(record.id);
          unindexGrant(record);
          n++;
        }
      }
      return n;
    },

    async deleteExpired(now) {
      let assignments = 0;
      let grants = 0;
      for (const record of [...state.assignments.values()]) {
        if (record.expiresAt !== undefined && record.expiresAt <= now) {
          state.assignments.delete(record.id);
          unindexAssignment(record);
          assignments++;
        }
      }
      for (const record of [...state.grants.values()]) {
        if (record.expiresAt !== undefined && record.expiresAt <= now) {
          state.grants.delete(record.id);
          unindexGrant(record);
          grants++;
        }
      }
      return { assignments, grants };
    },

    async listOwnershipRules() {
      return [...state.ownership.values()];
    },
    async getOwnershipRule(id) {
      return state.ownership.get(id);
    },
    async putOwnershipRule(record) {
      ensureCapacity(state.ownership, record.id, 'ownership rules');
      state.ownership.set(record.id, freezeCopy(record));
    },
    async deleteOwnershipRule(id) {
      return state.ownership.delete(id);
    },

    async listPolicies() {
      return [...state.policies.values()];
    },
    async getPolicy(id) {
      return state.policies.get(id);
    },
    async putPolicy(record) {
      ensureCapacity(state.policies, record.id, 'policies');
      state.policies.set(record.id, freezeCopy(record));
    },
    async deletePolicy(id) {
      return state.policies.delete(id);
    },

    async transaction<T>(fn: (tx: RbacStore) => Promise<T>): Promise<T> {
      const run = lock.then(async () => {
        const snapshot: State = {
          permissions: new Map(state.permissions),
          roles: new Map(state.roles),
          assignments: new Map(state.assignments),
          grants: new Map(state.grants),
          ownership: new Map(state.ownership),
          policies: new Map(state.policies),
          revision: state.revision,
        };
        try {
          return await fn(txStore);
        } catch (err) {
          state = snapshot;
          rebuildIndexes();
          throw err;
        }
      });
      lock = run.catch(() => undefined);
      return run;
    },
  };

  const txStore: RbacStore = {
    ...store,
    transaction: <T>(fn: (tx: RbacStore) => Promise<T>) => fn(txStore),
  };

  return store;
}
