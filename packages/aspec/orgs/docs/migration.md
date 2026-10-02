# Migration

Tables (prefix `orgs_`): `organisations`, `memberships`, `teams`,
`team_memberships`, `invitations`, `tenants`, `schema_migrations`.

```ts
import { migrate } from '@aspec/orgs/sql';
await migrate(client);
```

Idempotent. Initial migration id `0001_initial`. Schema-per-tenant strategies
create additional PostgreSQL schemas via `tenant.onSchemaProvision`; those are
application-owned.
