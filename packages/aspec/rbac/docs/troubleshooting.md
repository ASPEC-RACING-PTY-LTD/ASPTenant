# Troubleshooting

## `RBAC_FORBIDDEN`

The subject is authenticated but not allowed. Check assignments, scope, denies, grants and policies with `explain`. Middleware returns 403 problem+json without naming the permission.

## `RBAC_UNAUTHENTICATED`

No subject was resolved (401). Wire `getSubject` to your authentication layer.

## `RBAC_ROLE_NOT_FOUND`

The role key does not exist. Seed it with `defineRbac` or `admin.createRole`.

## `RBAC_CYCLE_DETECTED`

A parent link would create a cycle. `details.cycle` lists the keys.

## `RBAC_INVALID_PERMISSION`

The string is not `resource:action` (or a valid wildcard). Segments match `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}` or `*`.

## `RBAC_UNKNOWN_PERMISSION`

`requireRegisteredPermissions` is on and the pattern is not registered.

## `RBAC_INVALID_POLICY`

Condition failed validation (unknown operator, forbidden path segment, depth/size limit).

## `RBAC_SYSTEM_IMMUTABLE`

System roles/permissions/policies from the definition cannot be changed through the admin API.

## `RBAC_ROLE_IN_USE` / `RBAC_PERMISSION_IN_USE`

Delete with `{ force: true }` after reviewing dependents. Policies that reference a role always block deletion.

## `RBAC_ESCALATION`

`preventEscalation` blocked granting a permission the actor does not hold.

## `RBAC_INVALID_SNAPSHOT`

The React provider received a malformed snapshot. Produce it with `createPermissionSnapshot` on the server.

## `RBAC_PROVIDER_MISSING`

`useCan` / `Can` / `usePermissions` used outside `PermissionProvider`.
