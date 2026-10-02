# Fastify

```ts
import Fastify from 'fastify';
import { createAuditLogger, createMemoryAuditStore } from '@aspec/audit';
import { registerAuditContext, auditAdminPlugin } from '@aspec/audit/fastify';

const audit = createAuditLogger({ sink: createMemoryAuditStore() });
const app = Fastify();

registerAuditContext(app, {
  resolveActor: (req) => {
    const user = req.user as { id: string } | undefined;
    return user ? { id: user.id, type: 'user' } : undefined;
  },
});

app.post('/users', async () => {
  await audit.record({ action: 'users.create', category: 'data' });
  return { ok: true };
});

await app.register(auditAdminPlugin, {
  prefix: '/admin/audit',
  audit,
  authorize: async () => true, // replace with a real check
});
```
