import type { PolicyCondition } from './conditions.js';

/**
 * Where a role assignment applies or where a check is evaluated.
 * `{}` is the global scope, `{ orgId }` an organisation, `{ orgId, teamId }` a team.
 */
export interface RbacScope {
  orgId?: string;
  teamId?: string;
}

export type ScopeKind = 'global' | 'org' | 'team';
export const SCOPE_KINDS: readonly ScopeKind[] = ['global', 'org', 'team'];

export type Effect = 'allow' | 'deny';

export interface PermissionRecord {
  key: string;
  description?: string;
  /** Defined in code or configuration; immutable through the admin API. */
  system: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RoleRecord {
  key: string;
  name: string;
  description?: string;
  /** Allowed permission patterns (wildcards allowed). */
  permissions: readonly string[];
  /** Denied permission patterns; they override every allow. */
  denies: readonly string[];
  /** Parent role keys whose permissions and denies this role inherits. */
  parents: readonly string[];
  /** Scope kinds in which the role may be assigned. */
  assignableScopes: readonly ScopeKind[];
  system: boolean;
  /** Optimistic concurrency version, incremented on every update. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface AssignmentRecord {
  id: string;
  subjectId: string;
  roleKey: string;
  orgId?: string;
  teamId?: string;
  createdAt: number;
  createdBy?: string;
  expiresAt?: number;
}

export interface GrantRecord {
  id: string;
  /** Exactly one of subjectId and roleKey is set. */
  subjectId?: string;
  roleKey?: string;
  resourceType: string;
  resourceId: string;
  /** When set, the grant applies only when the evaluation scope is this organisation. */
  orgId?: string;
  permissions: readonly string[];
  effect: Effect;
  createdAt: number;
  createdBy?: string;
  expiresAt?: number;
}

export interface OwnershipRuleRecord {
  id: string;
  /** Resource type, or `*` for every type. */
  resourceType: string;
  permissions: readonly string[];
  description?: string;
  system: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PolicyRecord {
  id: string;
  description?: string;
  effect: Effect;
  /** Permission patterns the policy attaches to. */
  permissions: readonly string[];
  /** When set, the policy applies only to resources of these types. */
  resourceTypes?: readonly string[];
  /** When set, the policy applies only to subjects holding one of these roles in scope. */
  roles?: readonly string[];
  condition: PolicyCondition;
  system: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PageRequest {
  /** 1 to 500, default 50. */
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
