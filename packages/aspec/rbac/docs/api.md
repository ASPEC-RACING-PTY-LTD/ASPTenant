# API

## Core (`@aspec/rbac`)

### `createRbac(options?)`

Returns an `Rbac` engine implementing `PermissionChecker`.

| Method | Description |
|--------|-------------|
| `init()` | Seeds the definition and loads the catalogue (also called lazily) |
| `can(subject, permission, resource?, context?)` | `Promise<boolean>` |
| `check(...)` | Throws `RbacForbiddenError` when denied |
| `canAll` / `canAny` | Conjunction / disjunction over permission lists |
| `checkMany(subject, checks)` | Batch evaluation (one assignment load) |
| `decide` / `explain` | Decision and full trace |
| `permissionsFor` / `rolesFor` / `hasRole` | Effective roles and role-derived permissions |
| `createPermissionSnapshot(subject, options?)` | Browser-safe snapshot |
| `invalidate(subjectId?)` | Drop catalogue and optional assignment cache |
| `admin` | Administrative API |
| `store` | Underlying store |

### `defineRbac(input)` / `loadRbacConfig(json)`

Validate a definition (and optional options/sql) at startup.

### Subject helpers

`subjectFromClaims(claims, mapping?)`, `subjectFromUser(user, mapping?)`.

### Snapshot

`parsePermissionSnapshot(unknown)`, `createSnapshotEvaluator(snapshot)` with `can`, `canAll`, `canAny`, `hasRole`.

### Errors

`RbacError` and subclasses: `RbacForbiddenError`, `RbacUnauthenticatedError`, `RbacRoleNotFoundError`, `RbacCycleDetectedError`, `RbacInvalidPermissionError`, `RbacInvalidPolicyError`, `RbacValidationError`, `RbacConflictError`, `RbacInUseError`, `RbacImmutableError`, `RbacEscalationError`, `RbacLimitError`, `RbacConfigError`. Each has `code`, `status`, `expose`.

### Admin

`createRole`, `updateRole`, `deleteRole({ force })`, `assignRole`, `revokeRole`, `grant`, `revokeGrant`, permission/ownership/policy CRUD, `list*`, `effectivePermissions`, `purgeExpired`.

## Stores

- `@aspec/rbac/memory`: `createMemoryStore()`
- `@aspec/rbac/sql`: `migrate(client)`, `createSqlStore(client, { tablePrefix })`, `migrations`

## Adapters

- `@aspec/rbac/express`: `createRbacMiddleware`, `createRbacAdminRouter`
- `@aspec/rbac/fastify`: `createRbacHooks`, `createRbacAdminPlugin`
- `@aspec/rbac/hono`: `createRbacMiddleware`, `createRbacAdminApp`
- `@aspec/rbac/fetch`: `createRbacFetchGuards`, `createRbacAdminFetchHandler`
- `@aspec/rbac/react`: `PermissionProvider`, `Can`, `useCan`, `usePermissions`

Middleware helpers: `requirePermission`, `requireRole`, `requireAny`, `requireAll`.
