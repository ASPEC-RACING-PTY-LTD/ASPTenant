# Configure

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes (typical) | `postgres://`, `postgresql://`, `sqlite:`, `file:` or a SQLite path |
| `ASPEC_DB_MIGRATIONS_DIR` | no | Migrations directory for generated setup (default `migrations`) |

## Options (`createDatabase` / drivers)

- **PostgreSQL**: `host`, `port`, `user`, `password`, `database`, `ssl` (`disable` / `require` / `verify-ca` / `verify-full`, CA and client certs), `pool` (`max`, `idleTimeoutMs`, `connectionTimeoutMs`, `maxLifetimeSeconds`), `statementTimeoutMs`, `applicationName`, `searchPath`.
- **SQLite**: `filename`, `readonly`, `driver` (`better-sqlite3` or `node:sqlite`), `busyTimeoutMs` (default 5000), `journalMode` (default `wal` for files), `foreignKeys`, `safeIntegers`.
- **Shared**: `lazy`, `connectRetry`, `onQuery`, `logger`, `slowQueryThresholdMs`, `logParameters`, `tracer`, `healthTimeoutMs`, `closeTimeoutMs`.

`validateDatabaseConfig` and `parseDatabaseUrl` normalise input and redact passwords from every error message. See `config.schema.json`.
