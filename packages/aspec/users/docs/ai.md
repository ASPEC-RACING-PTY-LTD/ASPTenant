# AI agent guide

## Purpose

Manage user accounts: profiles, settings, preferences, suspension, activation,
invitations, soft deletion with purge, and activity history.

## Use when

- The app needs account lifecycle beyond authentication.
- You need invitations, suspension, or GDPR-style export/delete.

## Avoid when

- You only need sessions, passwords or OAuth (`@aspec/auth`).
- You only need permission evaluation (`@aspec/rbac`).

## Prerequisites

Node.js `>=22.13.0`. Optional: Express/Fastify/Hono peers, SQL database, Mailer,
JobQueue, AuditSink, PermissionChecker.

## Integration steps

1. Install `@aspec/users`.
2. Create a store: `createMemoryUsersStore()` or `migrate(client)` then
   `createSqlUsersStore(client)`.
3. `const users = createUsers({ store, /* optional ports */ })`.
4. Call service methods, or mount an adapter with `resolveActor`.
5. Register `createPurgeJobHandler(users)` if using soft delete with jobs.

## Configuration

Pass options to `createUsers`. Templates may read `USERS_ACCEPT_URL`,
`USERS_APP_NAME`, `USERS_DATABASE_URL`.

## Verification

```powershell
pnpm --filter @aspec/users typecheck
pnpm --filter @aspec/users test
```

Expect all tests to pass. With `ASPEC_TEST_POSTGRES_URL` set, SQL contract tests
run against PostgreSQL.

## Common mistakes

- Forgetting `migrate()` before using the SQL store.
- Mounting admin routes without a PermissionChecker.
- Expecting invitation emails without providing a Mailer (tokens are returned
  instead).
- Not registering a purge job handler, so soft-deleted accounts never purge.

## Uninstall

See [uninstall.md](uninstall.md).
