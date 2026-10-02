'use client';

import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { RbacError } from '../errors.js';
import {
  createSnapshotEvaluator,
  type PermissionSnapshot,
  parsePermissionSnapshot,
  type SnapshotEvaluator,
} from '../snapshot.js';

const PermissionContext = createContext<SnapshotEvaluator | null>(null);

export interface PermissionProviderProps {
  /** Snapshot from `rbac.createPermissionSnapshot(subject, options)`. */
  snapshot: PermissionSnapshot | unknown;
  children?: ReactNode;
}

/**
 * Provides a server-produced permission snapshot to `<Can>`, `useCan` and `usePermissions`.
 * Frontend guards are UX only; every sensitive action must be authorised on the server.
 */
export function PermissionProvider({ snapshot, children }: PermissionProviderProps): ReactNode {
  const evaluator = useMemo(() => {
    const parsed = parsePermissionSnapshot(snapshot);
    return createSnapshotEvaluator(parsed);
  }, [snapshot]);
  return <PermissionContext.Provider value={evaluator}>{children}</PermissionContext.Provider>;
}

function useEvaluator(): SnapshotEvaluator {
  const value = useContext(PermissionContext);
  if (!value) {
    throw new RbacError(
      'RBAC_PROVIDER_MISSING',
      'useCan/usePermissions/Can must be used within a PermissionProvider',
      { status: 500, expose: false },
    );
  }
  return value;
}

export interface CanProps {
  permission: string;
  /** Optional resource for grant and ownership checks in the snapshot. */
  resource?: { type: string; id?: string; ownerId?: string };
  /** Rendered when the permission is denied. Default: nothing. */
  fallback?: ReactNode;
  children?: ReactNode;
}

/** Conditionally renders children when the snapshot allows `permission`. UX only. */
export function Can({ permission, resource, fallback = null, children }: CanProps): ReactNode {
  const can = useEvaluator().can(permission, resource);
  return can ? children : fallback;
}

/** Returns whether the snapshot allows `permission` (optionally on a resource). UX only. */
export function useCan(
  permission: string,
  resource?: { type: string; id?: string; ownerId?: string },
): boolean {
  return useEvaluator().can(permission, resource);
}

/** Returns the snapshot evaluator (roles, permissions, can helpers). UX only. */
export function usePermissions(): SnapshotEvaluator {
  return useEvaluator();
}
