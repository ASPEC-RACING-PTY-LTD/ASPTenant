# AI agent guide

## Purpose

Organisations, teams, memberships, invitations and optional multi-tenancy.

## Use when

You need org/team structure or tenant isolation without forcing multi-tenancy.

## Avoid when

You only need user accounts (`@aspec/users`) or global RBAC (`@aspec/rbac`).

## Integration steps

1. Install `@aspec/orgs`.
2. Choose store; `migrate(client)` for SQL.
3. `createOrgs({ mode: 'single' | 'multi', store })`.
4. Call service APIs or mount adapters with `resolveActor`.
5. For multi-tenant data isolation: `provisionTenant`, `enterTenant`,
   `tenantScope`, optional `generateRlsPolicySql`.

## Verification

```powershell
pnpm --filter @aspec/orgs typecheck
pnpm --filter @aspec/orgs test
```

## Common mistakes

- Forgetting `migrate()`.
- Calling `createOrg` in single mode (use `getDefaultOrg`).
- Expecting RLS without FORCE / non-superuser role.
- Not checking membership before entering tenant context (use `enterTenant`).
