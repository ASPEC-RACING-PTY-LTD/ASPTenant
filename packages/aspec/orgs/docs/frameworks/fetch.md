# Fetch handler

```ts
import { createOrgs } from '@aspec/orgs';
import { createMemoryOrgsStore } from '@aspec/orgs/memory';
import { createOrgsAdminHandler, createOrgsMemberHandler } from '@aspec/orgs/fetch';

const orgs = createOrgs({ mode: 'multi', store: createMemoryOrgsStore() });
export const adminHandler = createOrgsAdminHandler(orgs, {
  basePath: '/admin',
  async resolveActor(req) {
    const id = req.headers.get('x-user-id');
    return id ? { id } : null;
  },
});
```
