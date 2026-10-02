# AI agent contract

## Purpose

Dev-only testing utilities for Node.js: Vitest scaffolding, fluent API clients, SQL fixtures, factories, auth/authz helpers, HTTP mocks, env isolation, coverage presets.

## Use when

- Writing API tests against Express, Fastify, Hono or Fetch handlers
- Isolating SQLite/PostgreSQL in tests
- Building seeded factories or mock permission checkers

## Avoid when

- Production runtime paths (dev dependency only)
- Generating cryptographic secrets with `Random`

## Prerequisites

Node `>=22.13.0`. Optional peers: `vitest`, `express`, `fastify`, `hono`, `pg`.

## Integration steps

1. `pnpm add -D @aspec/testing vitest`
2. Export `defineAspecVitestConfig({ setupFiles: ['test/setup.ts'] })` from `vitest.config.ts`
3. In setup: `setSeed(...)`; `afterEach` → `resetSequences()` + `await cleanupAll()`
4. In tests: `createTestClient(app)`, `defineFactory`, `createSqliteClient` / `createPostgresClient`, `mockFetch`
5. Optional: `pnpm exec aspec-testing init`

## Configuration

- `ASPEC_TEST_SEED` (optional)
- `ASPEC_TEST_POSTGRES_URL` (optional, for Postgres fixtures)

## Verification

```powershell
pnpm --filter @aspec/testing typecheck
$env:ASPEC_TEST_POSTGRES_URL='postgres://aspec:aspec-test-only@127.0.0.1:55432/aspec_test'
pnpm --filter @aspec/testing test
pnpm --filter @aspec/testing build
```

Expect tests to pass. PostgreSQL cases skip when the URL is unset.

## Common mistakes

- Forgetting `cleanupAll` after `mockFetch` (leaks global fetch)
- Calling `create()` without a factory adapter
- Passing multi-statement SQL with parameters
- Reusing test JWT secrets in production

## Uninstall

Remove the package and generated setup/scaffold files. No production data to clean.
