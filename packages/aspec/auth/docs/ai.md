# AI agent contract

## Purpose

Portable authentication: credentials, sessions, tokens, reset/verification, lockout, optional MFA / OIDC / WebAuthn.

## Use when

- The application needs first-party auth with a pluggable store and HTTP adapters.
- You must keep auth decoupled from profiles (`@aspec/users` or an existing users table).

## Avoid when

- A mandatory enterprise IdP already owns every sign-in and no local credentials are allowed.
- You only need API keys (use `@aspec/api-keys`).

## Prerequisites

Node `>=22.13.0`. Optional peers for Express/Fastify/Hono/WebAuthn as needed. SQL store needs a `SqlClient`.

## Integration steps

1. Install `@aspec/auth`.
2. Create `createMemoryAuthStore()` or migrate + `createSqlAuthStore(client)`.
3. Call `createAuth({ store, ... })` with links when a mailer is present.
4. Mount `createAuthRouter` / `createAuthPlugin` / `createAuthRoutes` / `createAuthFetchHandler` with `allowedOrigins`.
5. Optionally attach `createOidc` / `createWebAuthn` via HTTP options.

## Configuration

See configure.md for `AUTH_*` variables and factory options.

## Verification

```bash
pnpm --filter @aspec/auth test
pnpm --filter @aspec/auth typecheck
go run ./cmd/aspec dev validate modules/auth
```

Expect tests to pass (PostgreSQL cases run when `ASPEC_TEST_POSTGRES_URL` is set).

## Common mistakes

- Forgetting `allowedOrigins` with cookie CSRF enabled.
- Auto-linking OIDC by email without a verified email claim.
- Logging tokens or password hashes.
- Skipping `migrate()` before using the SQL store.

## Uninstall

Follow uninstall.md; drop `auth_*` tables only when data may be deleted.
