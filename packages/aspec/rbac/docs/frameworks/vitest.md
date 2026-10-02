# Vitest

The module's own suite runs under Vitest 5. Applications can import the portable core and memory store in tests without adapters.

```ts
import { createRbac, defineRbac } from '@aspec/rbac';
import { createMemoryStore } from '@aspec/rbac/memory';
import { describe, expect, it } from 'vitest';

describe('authorisation', () => {
  it('allows assigned permissions', async () => {
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
  });
});
```
