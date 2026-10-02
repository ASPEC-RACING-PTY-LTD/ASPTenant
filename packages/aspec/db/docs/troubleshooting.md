# Troubleshooting

## `DB_CONFIG_INVALID`

Configuration failed validation. Messages never include passwords. Check URL protocol, pool limits and SSL mode/cert pairs.

## `DB_DRIVER_MISSING`

Install `pg` for PostgreSQL or `better-sqlite3` for that SQLite driver (or use `@aspec/db/node-sqlite`).

## `DB_CONNECTION_FAILED`

Network, credentials or SSL mismatch. Retries with backoff already ran. Inspect logger warnings for attempt details (redacted).

## `DB_CLOSED`

The client was closed or a transaction handle was used after commit/rollback.

## `DB_MULTI_STATEMENT`

A parameterised query contained more than one statement. Put parameters only in single-statement queries; use parameterless scripts for migrations.

## `DB_MIGRATION_CHECKSUM_MISMATCH`

An applied migration file changed. Restore the original SQL and add a new migration for the change.

## `DB_MIGRATION_LOCK_TIMEOUT`

Another runner holds the advisory lock. Wait or raise `--lock-timeout`.

## `DB_MIGRATION_IRREVERSIBLE`

Rollback requested for a migration without a down step.

## `DB_SEED_REFUSED`

`NODE_ENV=production` without `--force` / `force: true`.

## `DB_TIMEOUT`

Health check exceeded `healthTimeoutMs`.
