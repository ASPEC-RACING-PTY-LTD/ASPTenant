# Testing

```powershell
$env:ASPEC_TEST_POSTGRES_URL='postgres://aspec:aspec-test-only@127.0.0.1:55432/aspec_test'
pnpm --filter @aspec/api-keys test
```

PostgreSQL store tests skip when `ASPEC_TEST_POSTGRES_URL` is unset.
