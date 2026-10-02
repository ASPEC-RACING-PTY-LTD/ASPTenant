# Fetch API

Suitable for Next.js route handlers and other runtimes that expose the Fetch API. Those runtimes were not separately tested; the handler itself was tested on Node 24.

```ts
import { createRbac, defineRbac, subjectFromClaims } from '@aspec/rbac';
import { createMemoryStore } from '@aspec/rbac/memory';
import { createRbacAdminFetchHandler, createRbacFetchGuards } from '@aspec/rbac/fetch';

const rbac = createRbac({
  store: createMemoryStore(),
  definition: defineRbac({
    permissions: ['posts:read'],
    roles: [{ key: 'viewer', permissions: ['posts:read', 'rbac:admin'] }],
  }),
});

const guards = createRbacFetchGuards(rbac);
const getSubject = (req: Request) => {
  const claims = /* parse JWT or session */;
  return claims ? subjectFromClaims(claims) : null;
};
const admin = createRbacAdminFetchHandler(rbac, { getSubject, basePath: '/admin/rbac' });

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/admin/rbac')) return admin(req);
  const g = await guards.requirePermission('posts:read', req, { getSubject });
  if (g.response) return g.response;
  return Response.json({ ok: true, subject: g.subject });
}
```
