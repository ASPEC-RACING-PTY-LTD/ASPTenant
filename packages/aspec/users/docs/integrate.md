# Integrate

## 1. Choose a store

```ts
import { createMemoryUsersStore } from '@aspec/users/memory';
// or
import { createSqlUsersStore, migrate } from '@aspec/users/sql';
import type { SqlClient } from '@aspec/users';

await migrate(client); // SqlClient for postgres or sqlite
const store = createSqlUsersStore(client);
// const store = createMemoryUsersStore();
```

Inline PostgreSQL adapter when not using `@aspec/db`:

```ts
import pg from 'pg';
import type { SqlClient } from '@aspec/users';

function fromPool(pool: pg.Pool): SqlClient {
  return {
    dialect: 'postgres',
    async query(sql, params = []) {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async transaction(fn) {
      const conn = await pool.connect();
      try {
        await conn.query('BEGIN');
        const tx: SqlClient = {
          dialect: 'postgres',
          query: async (sql, params = []) => {
            const r = await conn.query(sql, params as unknown[]);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
          },
          transaction: (inner) => inner(tx),
        };
        const out = await fn(tx);
        await conn.query('COMMIT');
        return out;
      } catch (err) {
        await conn.query('ROLLBACK');
        throw err;
      } finally {
        conn.release();
      }
    },
  };
}
```

## 2. Create the service

```ts
import { createUsers } from '@aspec/users';

const users = createUsers({
  store,
  // mailer, jobs, audit, permissions optional
  invitations: { acceptUrl: 'https://app.example.com/accept', appName: 'Acme' },
});
```

## 3. Use the API

```ts
const user = await users.createUser({
  email: 'ada@example.com',
  profile: { displayName: 'Ada', locale: 'en-GB', timezone: 'Europe/London' },
});

const invite = await users.inviteUser({ email: 'bob@example.com', roles: ['member'] });
// invite.token is set when no mailer is configured

await users.suspendUser(user.id, { reason: 'Abuse', actorId: 'admin-1' });
await users.requestDeletion(user.id);
```

## 4. Mount HTTP (optional)

See framework docs under `frameworks/express`, `frameworks/fastify`,
`frameworks/hono`, and `frameworks/fetch`. Always supply `resolveActor` from
your authentication layer.

## 5. Jobs (optional)

```ts
import { createPurgeJobHandler, PURGE_JOB_NAME } from '@aspec/users';

worker.register(PURGE_JOB_NAME, createPurgeJobHandler(users));
```

## Linking auth providers

Store `authProvider` and `externalId` on the user (unique together) via
`createUser` or `linkIdentity`. Look up with `findUserByExternalId`.
