# Migration

SQL tables (prefix `api_keys_` by default):

- `api_keys_keys`
- `api_keys_service_accounts`
- `api_keys_schema_migrations`

```ts
import { migrate } from '@aspec/api-keys/sql';
await migrate(sql, { tablePrefix: 'api_keys_' });
```

The memory store has no persistent schema.
