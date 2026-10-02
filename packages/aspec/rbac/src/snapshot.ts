import { RbacError } from './errors.js';
import {
  createPermissionSet,
  parsePermission,
  permissionCovers,
  permissionsOverlap,
} from './permissions.js';
import type { Effect, RbacScope } from './types.js';

/** A resource-scoped grant included in a permission snapshot. */
export interface SnapshotGrant {
  resourceType: string;
  resourceId: string;
  effect: Effect;
  permissions: readonly string[];
}

/** Precomputed decisions for one resource. */
export interface SnapshotResourceDecision {
  type: string;
  id?: string;
  allowed: readonly string[];
}

/**
 * Server-produced, browser-safe view of a subject's effective permissions.
 * Frontend guards evaluate against this without calling the engine.
 */
export interface PermissionSnapshot {
  version: 1;
  subjectId: string;
  scope: RbacScope;
  generatedAt: number;
  roles: readonly string[];
  permissions: readonly string[];
  denies: readonly string[];
  ownership: readonly { resourceType: string; permissions: readonly string[] }[];
  grants: readonly SnapshotGrant[];
  /** Server-evaluated results for requested permissions (no resource). */
  decisions: Record<string, boolean>;
  /** Server-evaluated results for requested permissions on specific resources. */
  resourceDecisions: readonly SnapshotResourceDecision[];
}

export interface SnapshotEvaluator {
  can(permission: string, resource?: { type: string; id?: string; ownerId?: string }): boolean;
  canAll(
    permissions: readonly string[],
    resource?: { type: string; id?: string; ownerId?: string },
  ): boolean;
  canAny(
    permissions: readonly string[],
    resource?: { type: string; id?: string; ownerId?: string },
  ): boolean;
  hasRole(role: string): boolean;
  readonly permissions: readonly string[];
  readonly roles: readonly string[];
  readonly snapshot: PermissionSnapshot;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new RbacError(
      'RBAC_INVALID_SNAPSHOT',
      `Invalid permission snapshot: ${path} must be a string array`,
      {
        status: 400,
        expose: true,
      },
    );
  }
  return value;
}

/**
 * Validates and freezes an unknown value as a PermissionSnapshot.
 * Throws RBAC_INVALID_SNAPSHOT when the shape is wrong.
 */
export function parsePermissionSnapshot(value: unknown): PermissionSnapshot {
  if (!isPlainObject(value)) {
    throw new RbacError('RBAC_INVALID_SNAPSHOT', 'Invalid permission snapshot: must be an object', {
      status: 400,
      expose: true,
    });
  }
  if (value.version !== 1) {
    throw new RbacError(
      'RBAC_INVALID_SNAPSHOT',
      'Invalid permission snapshot: unsupported version',
      {
        status: 400,
        expose: true,
      },
    );
  }
  if (typeof value.subjectId !== 'string' || value.subjectId.length === 0) {
    throw new RbacError(
      'RBAC_INVALID_SNAPSHOT',
      'Invalid permission snapshot: subjectId is required',
      {
        status: 400,
        expose: true,
      },
    );
  }
  if (typeof value.generatedAt !== 'number' || !Number.isFinite(value.generatedAt)) {
    throw new RbacError(
      'RBAC_INVALID_SNAPSHOT',
      'Invalid permission snapshot: generatedAt is required',
      {
        status: 400,
        expose: true,
      },
    );
  }
  if (!isPlainObject(value.scope)) {
    throw new RbacError(
      'RBAC_INVALID_SNAPSHOT',
      'Invalid permission snapshot: scope must be an object',
      {
        status: 400,
        expose: true,
      },
    );
  }
  const scope: RbacScope = {};
  if (typeof value.scope.orgId === 'string') scope.orgId = value.scope.orgId;
  if (typeof value.scope.teamId === 'string') scope.teamId = value.scope.teamId;

  const roles = asStringArray(value.roles, 'roles');
  const permissions = asStringArray(value.permissions, 'permissions');
  const denies = asStringArray(value.denies, 'denies');

  if (!Array.isArray(value.ownership)) {
    throw new RbacError(
      'RBAC_INVALID_SNAPSHOT',
      'Invalid permission snapshot: ownership must be an array',
      {
        status: 400,
        expose: true,
      },
    );
  }
  const ownership = value.ownership.map((item, index) => {
    if (!isPlainObject(item) || typeof item.resourceType !== 'string') {
      throw new RbacError(
        'RBAC_INVALID_SNAPSHOT',
        `Invalid permission snapshot: ownership.${index} is invalid`,
        { status: 400, expose: true },
      );
    }
    return {
      resourceType: item.resourceType,
      permissions: asStringArray(item.permissions, `ownership.${index}.permissions`),
    };
  });

  if (!Array.isArray(value.grants)) {
    throw new RbacError(
      'RBAC_INVALID_SNAPSHOT',
      'Invalid permission snapshot: grants must be an array',
      {
        status: 400,
        expose: true,
      },
    );
  }
  const grants: SnapshotGrant[] = value.grants.map((item, index) => {
    if (
      !isPlainObject(item) ||
      typeof item.resourceType !== 'string' ||
      typeof item.resourceId !== 'string' ||
      (item.effect !== 'allow' && item.effect !== 'deny')
    ) {
      throw new RbacError(
        'RBAC_INVALID_SNAPSHOT',
        `Invalid permission snapshot: grants.${index} is invalid`,
        {
          status: 400,
          expose: true,
        },
      );
    }
    return {
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      effect: item.effect,
      permissions: asStringArray(item.permissions, `grants.${index}.permissions`),
    };
  });

  if (!isPlainObject(value.decisions)) {
    throw new RbacError(
      'RBAC_INVALID_SNAPSHOT',
      'Invalid permission snapshot: decisions must be an object',
      {
        status: 400,
        expose: true,
      },
    );
  }
  const decisions: Record<string, boolean> = {};
  for (const [key, v] of Object.entries(value.decisions)) {
    if (typeof v !== 'boolean') {
      throw new RbacError(
        'RBAC_INVALID_SNAPSHOT',
        `Invalid permission snapshot: decisions.${key} must be a boolean`,
        { status: 400, expose: true },
      );
    }
    decisions[key] = v;
  }

  if (!Array.isArray(value.resourceDecisions)) {
    throw new RbacError(
      'RBAC_INVALID_SNAPSHOT',
      'Invalid permission snapshot: resourceDecisions must be an array',
      { status: 400, expose: true },
    );
  }
  const resourceDecisions: SnapshotResourceDecision[] = value.resourceDecisions.map(
    (item, index) => {
      if (!isPlainObject(item) || typeof item.type !== 'string') {
        throw new RbacError(
          'RBAC_INVALID_SNAPSHOT',
          `Invalid permission snapshot: resourceDecisions.${index} is invalid`,
          { status: 400, expose: true },
        );
      }
      const entry: SnapshotResourceDecision = {
        type: item.type,
        allowed: asStringArray(item.allowed, `resourceDecisions.${index}.allowed`),
      };
      if (typeof item.id === 'string') entry.id = item.id;
      return entry;
    },
  );

  return {
    version: 1,
    subjectId: value.subjectId,
    scope,
    generatedAt: value.generatedAt,
    roles,
    permissions,
    denies,
    ownership,
    grants,
    decisions,
    resourceDecisions,
  };
}

/**
 * Offline evaluator for a PermissionSnapshot.
 *
 * Order: resourceDecisions, then decisions (no resource only), then role/grant denies,
 * then allow patterns, ownership and grant allows. Default deny.
 */
export function createSnapshotEvaluator(snapshot: PermissionSnapshot): SnapshotEvaluator {
  const allow = createPermissionSet(snapshot.permissions);
  const deny = createPermissionSet(snapshot.denies);
  const ownershipByType = new Map<string, ReturnType<typeof createPermissionSet>>();
  for (const rule of snapshot.ownership) {
    ownershipByType.set(rule.resourceType, createPermissionSet(rule.permissions));
  }

  const can = (
    permission: string,
    resource?: { type: string; id?: string; ownerId?: string },
  ): boolean => {
    const perm = parsePermission(permission);

    if (resource) {
      for (const rd of snapshot.resourceDecisions) {
        if (rd.type !== resource.type) continue;
        if (resource.id !== undefined && rd.id !== undefined && rd.id !== resource.id) continue;
        if (resource.id !== undefined && rd.id === undefined) continue;
        if (resource.id === undefined && rd.id !== undefined) continue;
        return rd.allowed.some((p) => permissionCovers(p, perm.key) || p === perm.key);
      }
    } else if (Object.hasOwn(snapshot.decisions, perm.key)) {
      return snapshot.decisions[perm.key] === true;
    }

    if (deny.overlaps(perm)) return false;

    if (resource?.id !== undefined) {
      for (const g of snapshot.grants) {
        if (g.effect !== 'deny') continue;
        if (g.resourceType !== resource.type || g.resourceId !== resource.id) continue;
        if (g.permissions.some((p) => permissionsOverlap(p, perm.key))) return false;
      }
    }

    if (allow.covers(perm)) return true;

    if (resource?.ownerId !== undefined && resource.ownerId === snapshot.subjectId) {
      const typed = ownershipByType.get(resource.type);
      const star = ownershipByType.get('*');
      if (typed?.covers(perm) || star?.covers(perm)) return true;
    }

    if (resource?.id !== undefined) {
      for (const g of snapshot.grants) {
        if (g.effect !== 'allow') continue;
        if (g.resourceType !== resource.type || g.resourceId !== resource.id) continue;
        if (g.permissions.some((p) => permissionCovers(p, perm.key))) return true;
      }
    }

    return false;
  };

  return {
    can,
    canAll(permissions, resource) {
      return permissions.length > 0 && permissions.every((p) => can(p, resource));
    },
    canAny(permissions, resource) {
      return permissions.some((p) => can(p, resource));
    },
    hasRole(role) {
      return snapshot.roles.includes(role);
    },
    permissions: snapshot.permissions,
    roles: snapshot.roles,
    snapshot,
  };
}
