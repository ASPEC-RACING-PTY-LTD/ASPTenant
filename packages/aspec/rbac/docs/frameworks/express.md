# Express

Works with Express 4 and 5.

```ts
import express from 'express';
import { createRbac, defineRbac, subjectFromUser } from '@aspec/rbac';
import { createMemoryStore } from '@aspec/rbac/memory';
import { createRbacAdminRouter, createRbacMiddleware } from '@aspec/rbac/express';

const rbac = createRbac({
  store: createMemoryStore(),
  definition: defineRbac({
    permissions: ['posts:read', 'posts:write'],
    roles: [
      { key: 'viewer', permissions: ['posts:read'] },
      { key: 'editor', permissions: ['posts:write', 'rbac:admin'], parents: ['viewer'] },
    ],
  }),
});

const mw = createRbacMiddleware(rbac);
const getSubject = (req: express.Request) => (req.user ? subjectFromUser(req.user) : null);

const app = express();
app.get('/posts', mw.requirePermission('posts:read', { getSubject }), (req, res) => {
  res.json({ ok: true, subject: req.rbac?.subject });
});
app.use('/admin/rbac', createRbacAdminRouter(rbac, { getSubject }));
```

Denied requests return RFC 9457 `application/problem+json` (401 without a subject, 403 when denied). The 403 body never names the missing permission.
