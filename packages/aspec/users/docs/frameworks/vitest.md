# Vitest

Inject a clock and memory store for deterministic tests.

```ts
import { describe, expect, it } from 'vitest';
import { createUsers } from '@aspec/users';
import { createMemoryUsersStore } from '@aspec/users/memory';

describe('users', () => {
  it('creates a user', async () => {
    let now = 1_700_000_000_000;
    const users = createUsers({
      store: createMemoryUsersStore(),
      clock: { now: () => now },
    });
    const user = await users.createUser({ email: 'ada@example.com' });
    expect(user.status).toBe('active');
    expect(user.createdAt).toBe(now);
  });
});
```

For store contract coverage, run the same suite against memory, SQLite
(`node:sqlite`) and PostgreSQL when `ASPEC_TEST_POSTGRES_URL` is set.
