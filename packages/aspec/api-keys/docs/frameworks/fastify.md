# Fastify

```ts
import { createApiKeyPreHandler, apiKeysAdminPlugin } from '@aspec/api-keys/fastify';

app.get('/v1/me', { preHandler: createApiKeyPreHandler(apiKeys) }, handler);
await app.register(apiKeysAdminPlugin, {
  api: apiKeys,
  resolveActor: (req) => req.user,
  authorize: permissions,
  prefix: '/admin/api-keys',
});
```

Register with Fastify `prefix` so path matching strips the mount point.
