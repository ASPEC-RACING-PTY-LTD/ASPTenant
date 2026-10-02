# Testing

```powershell
$env:ASPEC_TEST_POSTGRES_URL='postgres://aspec:aspec-test-only@127.0.0.1:55432/aspec_test'
pnpm --filter @aspec/db test
```

The suite runs the SqlClient contract against better-sqlite3 and node:sqlite (memory and files) and PostgreSQL when `ASPEC_TEST_POSTGRES_URL` is set. PostgreSQL tests create a random schema and drop it afterwards. Without the variable, PostgreSQL cases are skipped and SQLite cases still pass.

For application tests, inject a `SqlClient` (for example an in-memory SQLite client from `createNodeSqliteClient({ filename: ':memory:' })`) instead of mocking query strings.
