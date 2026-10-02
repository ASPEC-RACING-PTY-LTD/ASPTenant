# AI integration

## Purpose

Provide a `SqlClient` and migration/seed tooling for PostgreSQL and SQLite without an ORM.

## Use when

- Other ASPEC modules need a SQL store.
- You need pooled connections, migrations with locking, or transaction retries.

## Avoid when

- You need MySQL/MariaDB (not implemented; use the `SqlDriver` boundary only if extending).
- You want Active Record / schema DSL modeling.

## Prerequisites

Node 22.13+, `DATABASE_URL`, and `pg` or a SQLite driver.

## Integration steps

1. `pnpm add @aspec/db pg` (or `better-sqlite3`).
2. `const db = await createDatabase({ url: process.env.DATABASE_URL })`.
3. `const migrator = createMigrator(db, { directory: 'migrations' }); await migrator.up()`.
4. Pass `db` into modules that accept `SqlClient`.
5. Use `withTransaction(db, fn, { retries: 3 })` for contended writes.
6. Call `await db.close()` on shutdown.

## Configuration

See [configure.md](configure.md). Never log raw `DATABASE_URL`.

## Verification

```bash
aspec-db status --url "$DATABASE_URL" --json
node -e "import('@aspec/db').then(m => m.createDatabase({ url: process.env.DATABASE_URL, lazy: true }).then(d => d.checkHealth().then(console.log)))"
```

Expect pending count and `{ ok: true, ... }` when the database is reachable.

## Common mistakes

- Changing applied migration SQL (checksum mismatch).
- Multi-statement queries with parameters.
- Seeding in production without `force`.
- Using `::text` casts in SQLite-shared SQL.

## Uninstall

See [uninstall.md](uninstall.md).
