# Hono

```ts
import { apiKeyMiddleware, createApiKeysAdminApp } from '@aspec/api-keys/hono';

app.use('/v1/*', apiKeyMiddleware(apiKeys));
app.route('/admin/api-keys', createApiKeysAdminApp(apiKeys, {
  resolveActor: (c) => c.get('user'),
  authorize: permissions,
}));
```

Principal is available as `c.get('apiKey')`.
