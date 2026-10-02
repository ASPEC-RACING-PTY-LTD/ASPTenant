# Fastify

```ts
import Fastify, { type FastifyRequest } from 'fastify';
import { createRbac, defineRbac, subjectFromUser } from '@aspec/rbac';
import { createMemoryStore } from '@aspec/rbac/memory';
import { createRbacAdminPlugin, createRbacHooks } from '@aspec/rbac/fastify';

const rbac = createRbac({
  store: createMemoryStore(),
  definition: defineRbac({
    permissions: ['posts:read'],
    roles: [{ key: 'viewer', permissions: ['posts:read', 'rbac:admin'] }],
  }),
});

const hooks = createRbacHooks(rbac);
const getSubject = (req: FastifyRequest) => {
  const user = (req as FastifyRequest & { user?: unknown }).user;
  return user ? subjectFromUser(user) : null;
};

const app = Fastify();
app.get('/posts', { preHandler: hooks.requirePermission('posts:read', { getSubject }) }, async () => ({ ok: true }));
await app.register(createRbacAdminPlugin(rbac, { getSubject }), { prefix: '/admin/rbac' });
```

Successful hooks set `request.rbac.subject`.
