# @aspec/orgs

Organisations, teams, memberships, invitations, tenant provisioning and tenant
isolation for single-tenant and multi-tenant Node.js applications.

Does not force multi-tenancy: use `mode: 'single'` for an implicit default
organisation. Integrates with `@aspec/rbac` through structural ports only.

## Install

```bash
aspec add aspec/orgs
# or
pnpm add @aspec/orgs
```

## Quick start

```ts
import { createOrgs } from '@aspec/orgs';
import { createMemoryOrgsStore } from '@aspec/orgs/memory';

const orgs = createOrgs({ mode: 'multi', store: createMemoryOrgsStore() });
const org = await orgs.createOrg({ name: 'Acme', createdBy: 'user-1' });
```

## Documentation

- [Summary](docs/summary.md)
- [Configure](docs/configure.md)
- [Integrate](docs/integrate.md)
- [API](docs/api.md)
- [Security](docs/security.md)
- [AI agent guide](docs/ai.md)

## Licence

MIT
