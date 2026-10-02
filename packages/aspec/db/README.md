# @aspec/db

Database utilities for PostgreSQL and SQLite: connections, pooling, migrations, transactions, health checks, seeding, instrumentation and configuration validation.

## Install

```bash
pnpm add @aspec/db
# PostgreSQL:
pnpm add pg
# SQLite (optional; node:sqlite is built into Node 22.13+):
pnpm add better-sqlite3
```

## Quick start

```ts
import { createDatabase, createMigrator } from '@aspec/db';

const db = await createDatabase({ url: process.env.DATABASE_URL! });
const migrator = createMigrator(db, { directory: 'migrations' });
await migrator.up();
```

CLI: `aspec-db migrate --url "$DATABASE_URL"`.

## Docs

See [docs/summary.md](docs/summary.md), [docs/integrate.md](docs/integrate.md), [docs/api.md](docs/api.md) and [docs/ai.md](docs/ai.md).
