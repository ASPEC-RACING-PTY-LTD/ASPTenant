# Vitest

```ts
import { describe, expect, it } from 'vitest';
import { createOrgs } from '@aspec/orgs';
import { createMemoryOrgsStore } from '@aspec/orgs/memory';

it('creates an org', async () => {
  const orgs = createOrgs({ mode: 'multi', store: createMemoryOrgsStore() });
  const org = await orgs.createOrg({ name: 'Acme', createdBy: 'u1' });
  expect(org.slug).toBe('acme');
});
```
