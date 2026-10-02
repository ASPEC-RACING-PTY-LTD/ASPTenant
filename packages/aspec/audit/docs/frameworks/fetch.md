# Fetch

Portable Web Fetch handler. Usable from runtimes that expose the Fetch API
(this module was tested with Node's built-in `Request` / `Response`).

```ts
import { createAuditLogger, createMemoryAuditStore } from '@aspec/audit';
import { withAuditContext, createAuditAdminFetchHandler } from '@aspec/audit/fetch';

const audit = createAuditLogger({ sink: createMemoryAuditStore() });

const api = withAuditContext(
  async (request) => {
    if (new URL(request.url).pathname === '/users' && request.method === 'POST') {
      await audit.record({ action: 'users.create', category: 'data' });
      return Response.json({ ok: true }, { status: 201 });
    }
    return new Response('not found', { status: 404 });
  },
  { resolveActor: () => ({ id: 'svc', type: 'service' }) },
);

const admin = createAuditAdminFetchHandler(audit, {
  basePath: '/admin/audit',
  authorize: async () => true,
});

export default async function handler(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/admin/audit')) return admin(request);
  return api(request);
}
```
