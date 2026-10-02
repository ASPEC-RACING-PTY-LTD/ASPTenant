# Fastify

```ts
import Fastify from 'fastify';
import { createOrgs } from '@aspec/orgs';
import { createMemoryOrgsStore } from '@aspec/orgs/memory';
import { createOrgsAdminPlugin, createOrgsMemberPlugin } from '@aspec/orgs/fastify';

const orgs = createOrgs({ mode: 'multi', store: createMemoryOrgsStore() });
const app = Fastify();
await app.register(createOrgsAdminPlugin(orgs, {
  async resolveActor(req) {
    const id = req.headers['x-user-id'];
    return typeof id === 'string' ? { id } : null;
  },
}), { prefix: '/admin' });
await app.register(createOrgsMemberPlugin(orgs, {
  async resolveActor(req) {
    const id = req.headers['x-user-id'];
    return typeof id === 'string' ? { id } : null;
  },
}), { prefix: '/member' });
```
