# API reference

Root import: `@aspec/testing`. Subpaths: `@aspec/testing/sql`, `@aspec/testing/coverage`, `@aspec/testing/scaffold`.

## Errors

- `TestingError` / `TestingAssertionError` with `code`, `status`, `expose` (ErrorLike shape)
- Codes: `TESTING_INVALID_OPTION`, `TESTING_ASSERTION_FAILED`, `TESTING_UNSUPPORTED_APP`, `TESTING_REQUEST_FAILED`, `TESTING_UNMATCHED_REQUEST`, `TESTING_JWT_INVALID`, `TESTING_FACTORY_*`, `TESTING_SQL_*`, `TESTING_FIXTURE_NOT_ACTIVE`, `TESTING_POSTGRES_DRIVER_MISSING`, `TESTING_PATH_OUTSIDE_ROOT`, `TESTING_COVERAGE_*`, `TESTING_SCAFFOLD_*`, `TESTING_CLEANUP_FAILED`

## Ports (local copies)

`SqlClient`, `Subject`, `ResourceRef`, `PermissionChecker`, `Clock`, `IdGenerator`

## API client

- `createTestClient(target, options?)` → `TestClient`
- `TestClient`: `get/post/put/patch/delete/head/options/request`, `withHeaders`, `withBearer`, `withJar`, `close`, `jar`, `kind`
- `TestRequest` (thenable): `query`, `set`, `type`, `accept`, `auth`, `cookie`, `send`, `timeout`, `expect`, `expectJson`, `expectText`, `expectHeader`, `expectNoHeader`, `expectCookie`
- `detectTargetKind(target)`, `actAs(client, credentials)`

## SQL

- `createSqliteClient()`, `createPostgresClient(options?)`, `createSqlFixture(options?)`
- `migrate(client, migrations, options?)`, `truncateTables(client, tables, options?)`
- `withTransactionRollback(client, fn)` / `withRollback`

## Factories

- `defineFactory(builder, options?)`, `createSequence`, `resetSequences`, `memoryPersistence`
- `createRandom`, `seededRandom`, `setSeed`, `getSeed`

## Auth / authz

- `signTestJwt`, `verifyTestJwt`, `decodeTestJwt`, `createTestJwtSigner`, `authHeader`
- `signCookieValue`, `unsignCookieValue`, `createSessionCookie`
- `createMockPermissionChecker`, `expectAllowed`, `expectDenied`, `expectPolicy`

## HTTP mock

- `mockFetch(options?)`, `createMockServer(options?)`, `reply.json/text/networkError/...`

## Environment

- `withEnv`, `isolateEnv`, `createTempDir`, `withTempDir`
- `createTestClock`, `useFakeTimers`, `withFakeTimers`
- `useFixture`, `registerCleanup`, `cleanupAll`, `pendingCleanups`

## Coverage

- `defineAspecVitestConfig`, `coverageSummary`, `checkCoverage`, `assertCoverage`

## Scaffold

- `detectProject`, `scaffoldInit`, `scaffoldGenerate`, `runScaffoldCli`
- Bin: `aspec-testing init|generate|detect [--dry-run] [--json]`
