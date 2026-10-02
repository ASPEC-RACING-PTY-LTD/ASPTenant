# API

## `@aspec/db`

| Export | Description |
|--------|-------------|
| `createDatabase(options)` | Creates a `Database` from URL/config; loads `pg` or SQLite drivers on demand |
| `createMigrator(client, options)` | File and programmatic migrations |
| `createMigrationFile(dir, name)` | Writes `NNNN_name.sql` |
| `loadMigrationFiles(dir)` / `parseMigrationSql` / `checksumSql` | Migration helpers |
| `createSeeder(client, options)` / `loadSeedFiles(dir)` | Idempotent seeding |
| `withTransaction(client, fn, options)` | Isolation, read-only, retries on 40001/40P01/SQLITE_BUSY |
| `checkDatabaseHealth` / `createHealthCheck` | HealthCheckable helpers |
| `parseDatabaseUrl` / `validateDatabaseConfig` / `describeDatabaseConfig` | Config validation |
| `createClientFromDriver` / `SqlDriver` | Adapter boundary for future dialects |
| `DbError` / `DbErrorCode` | Module errors |
| `redactUrl` / `redactText` / `redactSql` | Credential and SQL redaction |
| Ports: `SqlClient`, `LoggerLike`, `HealthCheckable`, `Clock` | Copied from integration ports |

`Database` extends `SqlClient` with `connect`, `close`, `connection`, `stats`, `checkHealth`, `driverName`.

## `@aspec/db/postgres`

`createPostgresClient`, `fromPgPool`, `buildPgSslOptions`, `buildPgPoolConfig`.

## `@aspec/db/sqlite`

`createSqliteClient` (`better-sqlite3`).

## `@aspec/db/node-sqlite`

`createNodeSqliteClient` (`node:sqlite`).

## `@aspec/db/otel`

`loadOpenTelemetryTracer()` returns a tracer when `@opentelemetry/api` is installed.

## CLI `aspec-db`

Commands: `migrate`, `status`, `rollback`, `create`, `seed`. Flags: `--url`, `--dir`, `--seeds`, `--table-prefix`, `--to`, `--steps`, `--only`, `--force`, `--driver`, `--ssl-ca`, `--lock-timeout`, `--json`. Exit codes: 0 ok, 1 failure, 2 usage, 3 refused.
