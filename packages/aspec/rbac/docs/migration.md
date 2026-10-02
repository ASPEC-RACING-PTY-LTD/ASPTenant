# Migration

## SQL tables

Prefix default `rbac_`. Tables:

- `rbac_permissions`
- `rbac_roles`
- `rbac_assignments`
- `rbac_grants`
- `rbac_ownership_rules`
- `rbac_policies`
- `rbac_meta`
- `rbac_schema_migrations`

## Apply migrations

```ts
import { migrate, createSqlStore } from '@aspec/rbac/sql';

await migrate(client, { tablePrefix: 'rbac_' });
const store = createSqlStore(client, { tablePrefix: 'rbac_' });
```

`migrate` is idempotent. PostgreSQL takes an advisory transaction lock. Dialects: `postgres` and `sqlite`.

## Memory store

No persistent state; nothing to migrate.

## Upgrades

Version 1.0.0 is the first release. Future schema changes ship as additional migration ids in `migrations`.
