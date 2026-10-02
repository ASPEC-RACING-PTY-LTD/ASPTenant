# Integrate

```ts
import { createOrgs } from '@aspec/orgs';
import { createMemoryOrgsStore } from '@aspec/orgs/memory';
// or: import { createSqlOrgsStore, migrate } from '@aspec/orgs/sql';

const orgs = createOrgs({ mode: 'multi', store: createMemoryOrgsStore() });
const org = await orgs.createOrg({ name: 'Acme', createdBy: 'user-1' });
await orgs.invite({ orgId: org.id, email: 'bob@example.com', role: 'member' });
await orgs.provisionTenant(org.id); // shared by default

await orgs.enterTenant({ slug: org.slug, userId: 'user-1' }, async () => {
  // currentTenant() is set; use tenantScope(sqlClient) inside transactions for RLS
});
```

Single-tenant:

```ts
const orgs = createOrgs({ mode: 'single', store });
const org = await orgs.getDefaultOrg();
```

PostgreSQL RLS: apply `generateRlsPolicySql({ tables: [...] })`, use a
non-superuser role or `FORCE ROW LEVEL SECURITY`, and wrap writes with
`tenantScope(client, orgId).transaction(...)`.
