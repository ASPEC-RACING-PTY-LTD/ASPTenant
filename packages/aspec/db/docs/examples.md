# Examples

## PostgreSQL with retries and health

```ts
import { createPostgresClient } from '@aspec/db/postgres';
import { withTransaction, checkDatabaseHealth } from '@aspec/db';

const db = createPostgresClient({
  url: process.env.DATABASE_URL!,
  pool: { max: 20 },
  ssl: { mode: 'verify-full', caFile: '/etc/ssl/certs/db-ca.pem' },
  applicationName: 'api',
});
await db.connect();
await withTransaction(db, async (tx) => {
  await tx.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [10, 1]);
}, { isolationLevel: 'serializable', retries: 5 });
console.log(await checkDatabaseHealth(db));
```

## File migrations

```sql
-- migrations/0001_users.sql
-- migrate:up
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
-- migrate:down
DROP TABLE users;
```

```ts
const migrator = createMigrator(db, { directory: 'migrations' });
await migrator.up();
```

## Instrumentation

```ts
const db = await createDatabase({
  url: process.env.DATABASE_URL!,
  slowQueryThresholdMs: 200,
  onQuery: (e) => console.log(e.durationMs, e.sql),
});
```
