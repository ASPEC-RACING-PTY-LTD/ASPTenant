# @aspec/rbac

Standalone authorisation for Node.js: roles, permissions, hierarchy, organisation and team scopes, resource grants, ownership, optional ABAC policies, admin HTTP API, framework middleware and React guards. Independent of authentication; resolve a `Subject` from your existing auth layer.

## Install

```bash
pnpm add @aspec/rbac
```

## Quick start

```ts
import { createRbac, defineRbac } from '@aspec/rbac';
import { createMemoryStore } from '@aspec/rbac/memory';

const rbac = createRbac({
  store: createMemoryStore(),
  definition: defineRbac({
    permissions: ['posts:read', 'posts:write'],
    roles: [
      { key: 'viewer', permissions: ['posts:read'] },
      { key: 'editor', permissions: ['posts:write'], parents: ['viewer'] },
    ],
  }),
});

await rbac.admin.assignRole({ subjectId: 'user-1', roleKey: 'editor' });
await rbac.check({ id: 'user-1' }, 'posts:write');
```

## Docs

- [Summary](docs/summary.md)
- [Install](docs/install.md)
- [Configure](docs/configure.md)
- [Integrate](docs/integrate.md) (precedence rules)
- [API](docs/api.md)
- [Security](docs/security.md)
- [AI agent guide](docs/ai.md)

## Licence

MIT
