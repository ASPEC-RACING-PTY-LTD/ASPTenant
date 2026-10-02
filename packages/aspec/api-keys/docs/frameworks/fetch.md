# Fetch API

```ts
import { withApiKeyAuth, createApiKeysAdminHandler } from '@aspec/api-keys/fetch';

export const handler = withApiKeyAuth(async (req, principal) => {
  return Response.json({ keyId: principal.keyId });
}, apiKeys, { scopes: ['read:data'] });

export const admin = createApiKeysAdminHandler(apiKeys, {
  resolveActor: () => adminSubject,
  authorize: permissions,
  basePath: '/admin/api-keys',
});
```

Can be used from runtimes that expose the Fetch API; only Node was tested.
