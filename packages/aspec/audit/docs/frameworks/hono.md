# Hono

```ts
import { Hono } from 'hono';
import { createAuditLogger, createMemoryAuditStore } from '@aspec/audit';
import { auditContext, createAuditAdminApp } from '@aspec/audit/hono';

const audit = createAuditLogger({ sink: createMemoryAuditStore() });
const app = new Hono();

app.use('*', auditContext({ resolveActor: (c) => c.get('user') }));

app.post('/users', async (c) => {
  await audit.record({ action: 'users.create', category: 'data' });
  return c.json({ ok: true }, 201);
});

app.route(
  '/admin/audit',
  createAuditAdminApp(audit, {
    authorize: async ({ request: c }) => Boolean(c.get('isAdmin')),
  }),
);
```
