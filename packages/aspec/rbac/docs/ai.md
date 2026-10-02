# AI agent guide

## Purpose

Standalone authorisation (RBAC + optional ABAC) independent of authentication.

## Use when

- You need roles, hierarchy, org/team scopes, resource grants or ownership.
- Multiple frameworks must share one permission model.

## Avoid when

- A hard-coded allow-list of a few permissions is enough.

## Prerequisites

- Node.js `>=22.13.0`
- A way to produce a `Subject` (`id`, optional `orgId`, `roles`, `teamIds`)

## Integration steps

1. `pnpm add @aspec/rbac` (plus framework peer if needed).
2. Create the engine:

```ts
import { createRbac, defineRbac } from '@aspec/rbac';
import { createMemoryStore } from '@aspec/rbac/memory';

export const rbac = createRbac({
  store: createMemoryStore(),
  definition: defineRbac({
    permissions: ['posts:read', 'posts:write'],
    roles: [
      { key: 'viewer', permissions: ['posts:read'] },
      { key: 'editor', permissions: ['posts:write'], parents: ['viewer'] },
    ],
  }),
});
```

3. Resolve subjects from auth (`subjectFromUser` / `subjectFromClaims`).
4. Mount middleware (`requirePermission`) and optionally the admin router under `/admin/rbac`.
5. For SQL: `await migrate(client)` then `createSqlStore(client)`.

## Configuration

See [configure.md](configure.md). Important env: `RBAC_DATABASE_URL`, `RBAC_TABLE_PREFIX`.

## Verification

```bash
pnpm --filter @aspec/rbac test
node -e "import('@aspec/rbac').then(m => console.log(typeof m.createRbac))"
```

Expect `createRbac` to be a function and tests to pass.

## Common mistakes

- Trusting React `<Can>` as the only check.
- Forgetting scope when assigning org roles.
- Expecting wildcards in `subject.roles` without registering matching roles.
- Skipping `migrate` before using the SQL store.

## Uninstall

See [uninstall.md](uninstall.md).
