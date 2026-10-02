# Hono

```ts
import { Hono } from 'hono';
import { createOrgs } from '@aspec/orgs';
import { createMemoryOrgsStore } from '@aspec/orgs/memory';
import { createOrgsAdminApp, createOrgsMemberApp } from '@aspec/orgs/hono';

const orgs = createOrgs({ mode: 'multi', store: createMemoryOrgsStore() });
const app = new Hono();
app.route('/admin', createOrgsAdminApp(orgs, {
  async resolveActor(c) {
    const id = c.req.header('x-user-id');
    return id ? { id } : null;
  },
}));
app.route('/member', createOrgsMemberApp(orgs, {
  async resolveActor(c) {
    const id = c.req.header('x-user-id');
    return id ? { id } : null;
  },
}));
```
