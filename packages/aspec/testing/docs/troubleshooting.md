# Troubleshooting

Organised by error code.

## TESTING_INVALID_OPTION

An options object failed validation (timeout, seed name, cookie format, threshold range). Read the message for the option name and fix the call site.

## TESTING_ASSERTION_FAILED

A fluent expectation or authz assertion failed. The message includes request/response context for HTTP failures and `actual`/`expected` for runners that render diffs.

## TESTING_UNSUPPORTED_APP

`createTestClient` could not detect the target. Pass an Express app, Fastify instance, Hono app, Fetch handler, URL, or set `options.kind`.

## TESTING_REQUEST_FAILED

The HTTP transport timed out or the ephemeral server failed. Increase `timeoutMs` or inspect the handler.

## TESTING_UNMATCHED_REQUEST

`mockFetch` (strict) received a request with no route. Register a route or call `mock.restore()` / use `strict: false` to fall through to the previous `fetch`.

## TESTING_JWT_INVALID

Signature, algorithm allow-list or time claim check failed. Ensure HS256 secrets are at least 32 bytes and clocks agree (`clock` / `clockToleranceSeconds`).

## TESTING_FACTORY_UNKNOWN_TRAIT / TESTING_FACTORY_NO_ADAPTER

Trait name is wrong, or `create()` was called without a persistence adapter.

## TESTING_SQL_MULTI_STATEMENT

A parameterised query contained more than one statement. Split it, or omit parameters for migration scripts.

## TESTING_SQL_INVALID_IDENTIFIER

A table or schema name failed the identifier check. Use `[A-Za-z_][A-Za-z0-9_]*` only.

## TESTING_FIXTURE_NOT_ACTIVE

`useFixture(...).value` was read outside setup/teardown.

## TESTING_POSTGRES_DRIVER_MISSING

Install the optional peer `pg`.

## TESTING_PATH_OUTSIDE_ROOT

A temp-dir helper rejected a path that escapes the directory.

## TESTING_COVERAGE_SUMMARY_MISSING / TESTING_COVERAGE_BELOW_THRESHOLD

Run Vitest with `--coverage` and the json-summary reporter (enabled by `defineAspecVitestConfig`), or lower thresholds.

## TESTING_SCAFFOLD_INVALID_NAME / TESTING_SCAFFOLD_CONFLICT

Fix the generate name, or remove conflicting files. Use `--dry-run` to preview.

## TESTING_CLEANUP_FAILED

One or more `cleanupAll` callbacks threw. Inspect the `AggregateError` cause.
