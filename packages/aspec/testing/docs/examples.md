# Examples

## Factory with association and persistence

```ts
import { defineFactory, memoryPersistence, resetSequences, setSeed } from '@aspec/testing';

setSeed('demo');
resetSequences();

const orgs = defineFactory((ctx) => ({ id: ctx.random.uuid(), name: ctx.random.word() }), { name: 'org' });
const users = defineFactory(
  (ctx) => ({
    id: ctx.random.uuid(),
    orgId: ctx.association(orgs, { select: (o) => o.id }),
    email: ctx.random.email(),
  }),
  { name: 'user', adapter: memoryPersistence() },
);

const user = await users.create({ email: 'ada@example.test' });
```

## SQL rollback fixture

```ts
import { createSqliteClient, migrate, withTransactionRollback } from '@aspec/testing';

const db = createSqliteClient();
await migrate(db, [{
  id: '001_items',
  sqlite: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL);',
  postgres: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL);',
}]);

await withTransactionRollback(db, async (tx) => {
  await tx.query('INSERT INTO items (id, name) VALUES ($1, $2)', ['1', 'x']);
});
// outer connection sees zero rows
```

## mockFetch strict restore

```ts
import { mockFetch, reply } from '@aspec/testing';

using mock = mockFetch();
mock.get('https://api.test/x', reply.json({ ok: true }));
await fetch('https://api.test/x');
mock.assertAllCalled();
```

## Coverage CI gate

```ts
import { assertCoverage } from '@aspec/testing';

await assertCoverage({ lines: 80, branches: 75 });
```
