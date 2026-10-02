# Database utilities

`@aspec/db` provides production SQL clients for PostgreSQL (`pg`) and SQLite (`better-sqlite3` or `node:sqlite`). It implements the shared `SqlClient` port (`$1` placeholders on every dialect, multi-statement parameterless scripts, nested transactions), plus pooling, migrations with checksums and locking, transaction retries, health checks, idempotent seeding, query instrumentation and password-safe configuration validation. Use `createDatabase`, the driver subpaths or the `aspec-db` CLI.
