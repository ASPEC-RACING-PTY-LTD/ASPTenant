# Express

Works with Express 4 and 5.

```ts
import express from 'express';
import { createAuditLogger, createMemoryAuditStore } from '@aspec/audit';
import { auditContext, auditAdminRouter } from '@aspec/audit/express';

const audit = createAuditLogger({ sink: createMemoryAuditStore() });
const app = express();

app.use(
  auditContext({
    trustProxy: 1,
    resolveActor: (req) => {
      const user = (req as express.Request & { user?: { id: string } }).user;
      return user ? { id: user.id, type: 'user' } : undefined;
    },
  }),
);

app.post('/users', async (req, res) => {
  await audit.record({
    action: 'users.create',
    resource: { type: 'user', id: 'new' },
    category: 'data',
  });
  res.status(201).json({ ok: true });
});

app.use(
  '/admin/audit',
  auditAdminRouter(audit, {
    authorize: async ({ request, action }) => {
      // Replace with your session / RBAC check.
      return Boolean((request as express.Request & { isAdmin?: boolean }).isAdmin) &&
        (action === 'audit.read' || action === 'audit.verify');
    },
  }),
);
```

Routes: `GET /admin/audit/events`, `/events/count`, `/events/:id`, `/streams`,
`/streams/:stream/verify`.
