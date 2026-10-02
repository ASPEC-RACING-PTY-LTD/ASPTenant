# Integrate

## Core (any TypeScript project)

```ts
import {
  createAuditLogger,
  createMemoryAuditStore,
  createSqlAuditStore,
  migrate,
} from '@aspec/audit';
import type { SqlClient } from '@aspec/audit';

// Development / tests
const audit = createAuditLogger({
  sink: createMemoryAuditStore({ maxEvents: 50_000 }),
  retention: { defaultDays: 90, categories: { security: 365 } },
});

// Production SQL (PostgreSQL or SQLite via SqlClient)
async function createSqlAudit(client: SqlClient) {
  await migrate(client);
  return createAuditLogger({
    sink: createSqlAuditStore(client),
    chain: { hmacKey: process.env.AUDIT_HMAC_KEY },
    retention: { defaultDays: 90, categories: { security: 365 } },
  });
}

await audit.record({
  action: 'users.profile.update',
  actor: { id: 'u1', type: 'user' },
  resource: { type: 'user', id: 'u1' },
  changes: { before: { role: 'member' }, after: { role: 'admin' } },
  category: 'admin',
});

const page = await audit.query({ actionPrefix: 'users.', limit: 50 });
await audit.applyRetention();
await audit.verifyAll();
```

## Inline SqlClient for `pg`

```ts
import pg from 'pg';
import type { SqlClient } from '@aspec/audit';

export function fromPool(pool: pg.Pool): SqlClient {
  return {
    dialect: 'postgres',
    query: async (sql, params = []) => {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: SqlClient = {
          dialect: 'postgres',
          query: async (sql, params = []) => {
            const r = await client.query(sql, params as unknown[]);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
          },
          transaction: (inner) => inner(tx),
        };
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
```

Mount a framework adapter next (see frameworks docs). Call `audit.flush()` and
`audit.close()` on graceful shutdown when using buffered or JSONL sinks.
