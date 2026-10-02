# Express

```ts
import { createApiKeyMiddleware, createApiKeysAdminRouter } from '@aspec/api-keys/express';

app.use('/v1', createApiKeyMiddleware(apiKeys, { scopes: ['read:data'] }));
app.use('/admin/api-keys', createApiKeysAdminRouter(apiKeys, {
  resolveActor: (req) => req.user,
  authorize: permissions,
}));
```

Works with Express 4 and 5. Sets `req.apiKey` on success. 401 responses use problem+json without revealing key existence.
