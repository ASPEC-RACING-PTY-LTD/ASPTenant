# Migrations

This module manages application migrations; it does not ship product tables of its own beyond tracking tables.

## Tracking tables

| Table | Purpose |
|-------|---------|
| `<prefix>schema_migrations` | Applied migrations (id, name, checksum, seq, applied_at, duration_ms) |
| `<prefix>seeds` | Applied seeds (id, checksum, applied_at) |

Default prefix: `db_`.

## Running

```bash
aspec-db migrate --url "$DATABASE_URL" --dir ./migrations
aspec-db status --url "$DATABASE_URL"
aspec-db rollback --steps 1
aspec-db create add_users
```

Or in code: `createMigrator(db, { directory, migrations, tablePrefix }).up()`.

Files are `NNNN_name.sql` with optional `-- migrate:down` and `-- migrate:no-transaction`. Applied SQL checksums are verified; changing an applied file is refused. Concurrent runners take a PostgreSQL advisory lock or SQLite `BEGIN IMMEDIATE`.
