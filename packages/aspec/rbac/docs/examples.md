# Examples

## Organisation-scoped editor

```ts
await rbac.admin.assignRole({
  subjectId: 'user-1',
  roleKey: 'editor',
  scope: { orgId: 'org-42' },
});

await rbac.can(
  { id: 'user-1' },
  'posts:write',
  { type: 'posts', id: 'p1', orgId: 'org-42' },
); // true

await rbac.can(
  { id: 'user-1' },
  'posts:write',
  { type: 'posts', id: 'p1', orgId: 'org-99' },
); // false
```

## Resource grant and ownership

```ts
await rbac.admin.grant({
  subjectId: 'user-1',
  resourceType: 'posts',
  resourceId: 'p1',
  permissions: ['posts:delete'],
});

await rbac.can({ id: 'user-1' }, 'posts:delete', { type: 'posts', id: 'p1' });

await rbac.can(
  { id: 'user-1' },
  'posts:write',
  { type: 'posts', id: 'p2', ownerId: 'user-1' },
);
```

## Explain a denial

```ts
const explanation = await rbac.explain({ id: 'user-1' }, 'billing:manage');
console.log(explanation.allowed, explanation.reason, explanation.matches);
```

## Audit sink

```ts
const rbac = createRbac({
  store,
  definition,
  audit: {
    async record(event) {
      await auditLogger.write(event);
    },
  },
  auditDenied: { sampleRate: 0.1 },
});
```
