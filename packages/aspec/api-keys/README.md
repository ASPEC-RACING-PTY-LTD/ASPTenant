# @aspec/api-keys

Secure API key generation, HMAC storage, scopes, expiry, rotation, revocation, usage tracking and service accounts.

## Install

```bash
pnpm add @aspec/api-keys
```

## Quick start

```ts
import { createApiKeys } from '@aspec/api-keys';
import { createMemoryStore } from '@aspec/api-keys/memory';
import { createApiKeyMiddleware } from '@aspec/api-keys/express';

const apiKeys = createApiKeys({
  store: createMemoryStore(),
  pepper: process.env.API_KEYS_PEPPER!,
});

app.use('/v1', createApiKeyMiddleware(apiKeys));
```

## Docs

- [Summary](docs/summary.md)
- [API](docs/api.md)
- [Security](docs/security.md)
- [AI agent guide](docs/ai.md)

## Licence

MIT
