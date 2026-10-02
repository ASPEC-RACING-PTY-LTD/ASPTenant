# Testing

Inject `clock` and use `createMemoryOrgsStore()`. Run store contracts against
memory, SQLite and PostgreSQL (`ASPEC_TEST_POSTGRES_URL`). RLS tests use
`FORCE ROW LEVEL SECURITY` and `SET LOCAL ROLE` on PostgreSQL.

```powershell
$env:ASPEC_TEST_POSTGRES_URL='postgres://aspec:aspec-test-only@127.0.0.1:55432/aspec_test'
pnpm --filter @aspec/orgs test
```
