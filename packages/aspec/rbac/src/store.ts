import type {
  AssignmentRecord,
  GrantRecord,
  OwnershipRuleRecord,
  Page,
  PermissionRecord,
  PolicyRecord,
  RoleRecord,
} from './types.js';

export interface AssignmentFilter {
  subjectId?: string;
  roleKey?: string;
  /** Exact organisation match. Use `null` to select global assignments only. */
  orgId?: string | null;
  /** Exact team match. Use `null` to select assignments without a team. */
  teamId?: string | null;
}

export interface GrantFilter {
  subjectId?: string;
  roleKey?: string;
  resourceType?: string;
  resourceId?: string;
  orgId?: string | null;
}

/** Lookup used on the evaluation hot path: grants on one resource for a subject or its roles. */
export interface GrantLookup {
  resourceType: string;
  resourceId: string;
  subjectId: string;
  roleKeys: readonly string[];
}

/** Lookup used for permission snapshots: grants held by a subject or its roles. */
export interface PrincipalGrantLookup {
  subjectId: string;
  roleKeys: readonly string[];
  /** Restrict to these resources (`type` + `id`). */
  resources?: readonly { type: string; id: string }[];
  limit: number;
}

export interface StorePage {
  limit: number;
  cursor?: string;
}

/**
 * Persistence port for every RBAC entity. Implementations: createMemoryStore (`./memory`) and
 * createSqlStore (`./sql`). Records returned by a store must be treated as immutable.
 *
 * Catalogue collections (permissions, roles, ownership rules, policies) are small and listed
 * whole. Assignments and grants are unbounded and paginated by `id` order.
 */
export interface RbacStore {
  listPermissions(): Promise<PermissionRecord[]>;
  getPermission(key: string): Promise<PermissionRecord | undefined>;
  /** Insert or replace by key. */
  putPermission(record: PermissionRecord): Promise<void>;
  deletePermission(key: string): Promise<boolean>;

  listRoles(): Promise<RoleRecord[]>;
  getRole(key: string): Promise<RoleRecord | undefined>;
  /** Returns false when a role with the key already exists. */
  insertRole(record: RoleRecord): Promise<boolean>;
  /** Replaces the role when its stored version equals expectedVersion. Returns false otherwise. */
  updateRole(record: RoleRecord, expectedVersion: number): Promise<boolean>;
  deleteRole(key: string): Promise<boolean>;
  /** Monotonic counter of role hierarchy changes, used to serialise hierarchy edits. */
  getRolesRevision(): Promise<number>;
  /** Atomically increments the revision when it still equals expected. */
  bumpRolesRevision(expected: number): Promise<boolean>;

  /** Every assignment of one subject (all scopes). Hot path; must use an index. */
  listAssignmentsForSubject(subjectId: string): Promise<AssignmentRecord[]>;
  listAssignments(filter: AssignmentFilter, page: StorePage): Promise<Page<AssignmentRecord>>;
  countAssignments(filter: AssignmentFilter): Promise<number>;
  getAssignment(id: string): Promise<AssignmentRecord | undefined>;
  /**
   * Inserts the assignment unless one exists for the same subject, role, organisation and
   * team. Returns the stored record and whether it was created.
   */
  insertAssignment(
    record: AssignmentRecord,
  ): Promise<{ record: AssignmentRecord; created: boolean }>;
  deleteAssignment(id: string): Promise<boolean>;
  deleteAssignmentsForRole(roleKey: string): Promise<number>;

  /** Grants on one resource for the subject or any of the role keys. Hot path. */
  findGrants(lookup: GrantLookup): Promise<GrantRecord[]>;
  listGrantsForPrincipals(lookup: PrincipalGrantLookup): Promise<GrantRecord[]>;
  listGrants(filter: GrantFilter, page: StorePage): Promise<Page<GrantRecord>>;
  countGrants(filter: GrantFilter): Promise<number>;
  getGrant(id: string): Promise<GrantRecord | undefined>;
  insertGrant(record: GrantRecord): Promise<void>;
  deleteGrant(id: string): Promise<boolean>;
  deleteGrantsForRole(roleKey: string): Promise<number>;

  /** Deletes assignments and grants whose expiresAt is at or before now. */
  deleteExpired(now: number): Promise<{ assignments: number; grants: number }>;

  listOwnershipRules(): Promise<OwnershipRuleRecord[]>;
  getOwnershipRule(id: string): Promise<OwnershipRuleRecord | undefined>;
  putOwnershipRule(record: OwnershipRuleRecord): Promise<void>;
  deleteOwnershipRule(id: string): Promise<boolean>;

  listPolicies(): Promise<PolicyRecord[]>;
  getPolicy(id: string): Promise<PolicyRecord | undefined>;
  putPolicy(record: PolicyRecord): Promise<void>;
  deletePolicy(id: string): Promise<boolean>;

  /** Runs fn atomically. The store passed to fn must be used for every operation inside. */
  transaction<T>(fn: (store: RbacStore) => Promise<T>): Promise<T>;
}
