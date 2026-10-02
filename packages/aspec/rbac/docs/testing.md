# Testing

Use the in-memory store for unit tests. For store contracts, run the same suite against memory, SQLite and PostgreSQL.

```ts
import { createRbac, defineRbac } from '@aspec/rbac';
import { createMemoryStore } from '@aspec/rbac/memory';

const rbac = createRbac({
  store: createMemoryStore(),
  definition: defineRbac({
    permissions: ['posts:read'],
    roles: [{ key: 'viewer', permissions: ['posts:read'] }],
  }),
  preventEscalation: false,
});

await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'viewer' });
expect(await rbac.can({ id: 'u1' }, 'posts:read')).toBe(true);
```

PostgreSQL tests should create a random schema and drop it afterwards. Skip when `ASPEC_TEST_POSTGRES_URL` is unset:

```ts
describe.skipIf(!process.env.ASPEC_TEST_POSTGRES_URL)('postgres', () => { /* ... */ });
```

React tests: `/** @vitest-environment happy-dom */` with `@testing-library/react`.
