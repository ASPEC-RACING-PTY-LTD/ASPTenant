# Integrate

```ts
import { createApiKeys } from '@aspec/api-keys';
import { createMemoryStore } from '@aspec/api-keys/memory';

const apiKeys = createApiKeys({
  store: createMemoryStore(),
  pepper: process.env.API_KEYS_PEPPER!,
});

const { key, secret } = await apiKeys.create({
  name: 'ci',
  scopes: ['read:data'],
  ownerType: 'user',
  ownerId: 'u1',
});
// Show secret once; it is never stored.
```

SQL:

```ts
import { createSqlStore, migrate } from '@aspec/api-keys/sql';
await migrate(sql);
const store = createSqlStore(sql);
```
