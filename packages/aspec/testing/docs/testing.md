# Testing this module

From the repository root:

```powershell
$env:ASPEC_TEST_POSTGRES_URL='postgres://aspec:aspec-test-only@127.0.0.1:55432/aspec_test'
pnpm --filter @aspec/testing test
```

Coverage:

- Express 4 (`express4`), Express 5, Fastify inject, Hono `app.request`, Fetch handlers
- SQLite (`node:sqlite`) and PostgreSQL schema lifecycle when `ASPEC_TEST_POSTGRES_URL` is set
- Seeded factory determinism, JWT verification with `node:crypto`, mock permission checker
- `mockFetch` strict mode and restore, mock server, env isolation including deletions
- Scaffolding into temp dirs (TypeScript and JavaScript, no overwrite, dry-run)
- Coverage config shape; `node --test` child process consuming the built package

PostgreSQL tests use `describe.skipIf(!process.env.ASPEC_TEST_POSTGRES_URL)` so the suite passes without services.
