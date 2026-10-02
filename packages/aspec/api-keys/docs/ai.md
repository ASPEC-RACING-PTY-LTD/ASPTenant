# AI agent guide

## Purpose

Secure API key lifecycle for Node.js services.

## Use when

Machine clients need scoped, rotatable, revocable credentials.

## Avoid when

You need end-user passwords or OAuth (use auth modules).

## Integration steps

1. Install `@aspec/api-keys`.
2. Set `API_KEYS_PEPPER` (>= 32 bytes).
3. Create store (memory or SQL + migrate).
4. `createApiKeys({ store, pepper })`.
5. Mount verification middleware; optionally mount admin router with authorize.

## Verification

`pnpm --filter @aspec/api-keys test` with Postgres URL for SQL coverage.

## Common mistakes

Logging the secret; forgetting pepper in production; mounting admin without authorisation.
