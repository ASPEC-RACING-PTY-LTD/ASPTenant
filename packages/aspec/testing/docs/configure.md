# Configure

There is no required runtime configuration. Helpers accept options objects.

## Environment variables

| Name | Description |
|------|-------------|
| `ASPEC_TEST_SEED` | Default seed for factories and `seededRandom` (default `aspec-testing`). |
| `ASPEC_TEST_POSTGRES_URL` | PostgreSQL URL for `createPostgresClient` when `url` is omitted. |

## Options overview

- `createTestClient(app, { kind, origin, headers, jar, timeoutMs, clock, hono })`
- `createPostgresClient({ url, schema, manageSchema, pg })`
- `defineFactory(builder, { name, traits, adapter, afterBuild, afterCreate })`
- `createTestJwtSigner({ algorithm, secret, privateKey, issuer, audience, expiresIn, clock })`
- `mockFetch({ strict, global, maxRecordedCalls })`
- `defineAspecVitestConfig({ include, setupFiles, coverage, test })`
- `scaffoldInit({ cwd, dryRun, language, moduleSystem, importSpecifier })`

See `config.schema.json` for the serialisable subset used by explorers and installers.
