# Hono

```ts
import { Hono } from 'hono';
import { createRbac, defineRbac, subjectFromUser } from '@aspec/rbac';
import { createMemoryStore } from '@aspec/rbac/memory';
import { createRbacAdminApp, createRbacMiddleware } from '@aspec/rbac/hono';

const rbac = createRbac({
  store: createMemoryStore(),
  definition: defineRbac({
    permissions: ['posts:read'],
    roles: [{ key: 'viewer', permissions: ['posts:read', 'rbac:admin'] }],
  }),
});

const mw = createRbacMiddleware(rbac);
const getSubject = (c: { get: (k: string) => unknown }) => {
  const user = c.get('user');
  return user ? subjectFromUser(user) : null;
};

const app = new Hono();
app.get('/posts', mw.requirePermission('posts:read', { getSubject }), (c) => c.json({ ok: true }));
app.route('/admin/rbac', createRbacAdminApp(rbac, { getSubject }));
```

Successful middleware sets `c.get('rbac').subject`.
