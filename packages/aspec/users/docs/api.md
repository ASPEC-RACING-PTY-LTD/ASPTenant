# API

## `createUsers(options): UsersService`

Creates the service. See [configure.md](configure.md).

## UsersService

### Accounts

| Method | Description |
|--------|-------------|
| `createUser(input, context?)` | Create account (optional `id`, `externalId`/`authProvider`) |
| `getUser(id)` / `findUser(id)` | Load by id (throws / null) |
| `findUserByEmail(email)` | Normalised email lookup |
| `findUserByExternalId(provider, externalId)` | Auth provider link |
| `listUsers(query?)` | Cursor page (`status`, `search`, `limit`, `cursor`) |
| `canSignIn(id)` | Active and not suspended (reinstates expired suspensions) |

### Profile and settings

| Method | Description |
|--------|-------------|
| `updateProfile(id, patch, options?, context?)` | Display name, avatar, locale, timezone, bio, fields |
| `changeEmail(id, email, options?, context?)` | Unique normalised email |
| `linkIdentity(id, identity \| null, ...)` | Set or clear auth provider link |
| `updateMetadata(id, metadata, ...)` | Replace metadata object |
| `getSettings` / `updateSettings` | Typed settings |
| `getPreferences` / `updatePreferences` | Merged preferences (defaults + overrides) |

Optimistic concurrency: pass `options.expectedVersion` or `If-Match` on HTTP.

### Suspension and activation

| Method | Description |
|--------|-------------|
| `suspendUser(id, { reason, actorId?, until? })` | Suspend; optional `until` for auto reinstate |
| `reactivateUser(id)` | Clear suspension |
| `reinstateExpiredSuspensions(limit?)` | Maintenance helper |
| `activateUser(id)` | Admin activate |
| `createActivationToken(id)` | Hashed single-use token |
| `activateWithToken(token)` | Consume token |

### Invitations

| Method | Description |
|--------|-------------|
| `inviteUser({ email, roles?, metadata? })` | Create pending invite; mailer category `users.invitation` |
| `resendInvitation(id)` | Throttled resend |
| `revokeInvitation(id)` | Revoke |
| `acceptInvitation(token, input?)` | Idempotent accept (create or activate) |
| `getInvitation` / `listInvitations` | Read |

Without a mailer, `InvitationResult.token` is returned for manual delivery.

### Deletion

| Method | Description |
|--------|-------------|
| `requestDeletion(id, input?)` | Soft delete; schedules purge when `jobs` set |
| `cancelDeletion(id)` | Cancel during grace period |
| `purgeUser(id, { force? })` | Anonymise or hard-delete |
| `purgeExpired(limit?)` | Process due purges |
| `exportUserData(id)` | Portable export |

Hook `user.purging` runs before purge so apps can delete owned data.

### Activity

| Method | Description |
|--------|-------------|
| `recordActivity` / `recordLogin` | Append events |
| `listActivity(userId, query?)` | Cursor page |
| `pruneActivity({ olderThanMs? })` | Retention prune |
| `runMaintenance()` | Reinstate + purge + prune |

### Other

| Method | Description |
|--------|-------------|
| `can(subject, permission, resource?)` | Delegates to PermissionChecker |
| `on(event, listener)` | Subscribe to hooks; returns unsubscribe |

## Stores

- `createMemoryUsersStore(options?)` from `@aspec/users/memory`
- `createSqlUsersStore(client, options?)`, `migrate(client)`, `migrations` from `@aspec/users/sql`

## HTTP helpers

- Express: `createUsersAdminRouter`, `createUsersSelfServiceRouter`
- Fastify: `createUsersAdminPlugin`, `createUsersSelfServicePlugin`
- Hono: `createUsersAdminApp`, `createUsersSelfServiceApp`
- Fetch: `createUsersAdminHandler`, `createUsersSelfServiceHandler`

## Jobs

- `createPurgeJobHandler(service)` for job name `users.purge` (`PURGE_JOB_NAME`)
- `createMaintenanceJobHandler(service)` for `users.maintenance`

## Errors

`UsersError` with `code`, `status`, `expose`, optional `details`. See
[troubleshooting.md](troubleshooting.md).
