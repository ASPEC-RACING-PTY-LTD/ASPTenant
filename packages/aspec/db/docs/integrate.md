# Integrate

1. Install `@aspec/db` and `pg` or a SQLite driver.
2. Set `DATABASE_URL`.
3. Generate setup with `aspec add aspec/db` (or copy the generic template) so you get `src/aspec/db.setup.ts`.
4. On startup:

```ts
import { db, migrator } from './aspec/db.setup.js';

await migrator.up();
// pass db to other modules that accept SqlClient
```

A CommonJS project (`package.json` without `"type": "module"`) gets `openDatabase()` instead, because that module system cannot use top-level await:

```ts
import { openDatabase } from './aspec/db.setup.js';

const { db, migrator } = await openDatabase();
```

5. For an existing `pg.Pool`:

```ts
import { fromPgPool } from '@aspec/db/postgres';
const db = fromPgPool(pool);
```

6. CLI alternative: `aspec-db migrate`, `aspec-db status`, `aspec-db rollback`, `aspec-db create <name>`, `aspec-db seed`.
