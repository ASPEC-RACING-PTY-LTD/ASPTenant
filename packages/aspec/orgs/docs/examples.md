# Examples

## Invite without mailer

```ts
const { token, invitation } = await orgs.invite({
  orgId: org.id,
  email: 'bob@example.com',
  role: 'admin',
  teamIds: [team.id],
});
await orgs.acceptInvitation(token!, { userId: 'bob', email: 'bob@example.com' });
```

## Schema-per-tenant provisioning

```ts
const orgs = createOrgs({
  mode: 'multi',
  store,
  tenant: {
    defaultStrategy: 'schema',
    async onSchemaProvision({ schema }) {
      await adminSql.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await runAppMigrations(schema);
    },
  },
});
await orgs.provisionTenant(org.id, { strategy: 'schema' });
```

## RLS-scoped query

```ts
import { generateRlsPolicySql, tenantScope } from '@aspec/orgs';

await admin.query(generateRlsPolicySql({ tables: ['orders'] }));
await tenantScope(sql, org.id).transaction(async (tx) => {
  await tx.query('INSERT INTO orders (id, tenant_id, total) VALUES ($1,$2,$3)', [
    'o1',
    org.id,
    10,
  ]);
});
```
