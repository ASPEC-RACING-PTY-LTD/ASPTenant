# Integrate

## Model

- **Permissions** are `resource:action` (or `*`, `posts:*`, `*:read`). Register them with descriptions; custom permissions can be added at runtime through the admin API.
- **Roles** have keys, permissions, denies, parents and assignable scopes. The hierarchy is a DAG (cycles are rejected). Effective permissions inherit from parents.
- **Assignments** bind a subject to a role in a scope: global, organisation (`orgId`), or team (`orgId` + `teamId`).
- **Grants** give a subject or role permissions on a concrete resource (`type` + `id`), optionally org-scoped.
- **Ownership** rules grant listed permissions when `resource.ownerId === subject.id`.
- **Policies** (optional ABAC) attach allow or deny effects to permission patterns with safe JSON conditions over `{ subject, resource, context }`.

## Precedence (fixed order)

1. **Denies win**, checked in this order: role denies (including inherited), resource grant denies, deny policies whose condition is true.
2. **Allows**, checked in this order: role permissions, resource grant allows, ownership rules, allow policies.
3. Otherwise **default deny**.

`explain` lists every matching rule; the decisive entry is the first deny, else the first allow.

## Evaluation scope

1. If `resource.orgId` is set, it wins (and `resource.teamId` when present).
2. Else `context.scope`, else `subject.orgId`, else global.
3. Global assignments apply everywhere. Org assignments apply in that org (and its teams when `orgRolesApplyToTeams` is true). Team assignments apply only in that team.
4. An assignment is ignored when its scope kind is not in the role's `assignableScopes`.
5. Static `subject.roles` with `staticRoles: 'auto'` apply within `subject.orgId` when set, otherwise globally.

## Queries per check

One assignment lookup (optionally cached), plus one indexed grant query only when the resource has an `id`. Batch checks memoise grants per resource.

## Minimal wiring

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

// From your auth layer (no dependency on @aspec/auth):
const subject = { id: user.id, orgId: user.orgId, roles: user.tokenRoles };
if (!(await rbac.can(subject, 'posts:write', { type: 'posts', id, ownerId: post.authorId }))) {
  throw new Error('Forbidden');
}
```

## Subject helpers

```ts
import { subjectFromClaims, subjectFromUser } from '@aspec/rbac';

subjectFromClaims(jwtPayload); // defaults: sub, roles, org_id, team_ids
subjectFromUser(req.user);     // Passport / session defaults: id, roles, orgId, teamIds
```

Map `@aspec/auth` (or any provider) through `subjectFromUser` or a custom resolver. This module never imports authentication packages.

## Frontend

Produce a `PermissionSnapshot` on the server with `createPermissionSnapshot`, then wrap React trees with `PermissionProvider`. Frontend guards are UX only; re-check on the server.
