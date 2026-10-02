# Express

```ts
import express from 'express';
import { createOrgs } from '@aspec/orgs';
import { createMemoryOrgsStore } from '@aspec/orgs/memory';
import {
  createOrgsAdminRouter,
  createOrgsMemberRouter,
  createTenantMiddleware,
} from '@aspec/orgs/express';

const orgs = createOrgs({ mode: 'multi', store: createMemoryOrgsStore() });
const app = express();
const resolveActor = async (req: express.Request) => {
  const id = req.headers['x-user-id'];
  return typeof id === 'string' ? { id } : null;
};

app.use('/admin', createOrgsAdminRouter(orgs, { resolveActor }));
app.use('/member', createOrgsMemberRouter(orgs, { resolveActor }));
app.use(
  createTenantMiddleware(orgs, {
    resolveActor,
    tenant: { method: 'header', header: 'x-tenant-id' },
    resolveUserId: async (req) => {
      const id = req.headers['x-user-id'];
      return typeof id === 'string' ? id : null;
    },
  }),
);
```
