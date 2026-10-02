# React

Frontend guards are UX only. Produce a snapshot on the server and never trust the client for authorisation.

```tsx
// Server
const snapshot = await rbac.createPermissionSnapshot(subject, {
  permissions: ['posts:read', 'posts:write'],
  resources: [{ type: 'posts', id: postId }],
});

// Client
import { PermissionProvider, Can, useCan } from '@aspec/rbac/react';

export function Page({ snapshot }) {
  return (
    <PermissionProvider snapshot={snapshot}>
      <Can permission="posts:write" fallback={<p>Read only</p>}>
        <EditButton />
      </Can>
    </PermissionProvider>
  );
}

function EditButton() {
  const canWrite = useCan('posts:write');
  return <button disabled={!canWrite}>Edit</button>;
}
```

`PermissionProvider`, `Can`, `useCan` and `usePermissions` import only browser-safe modules (no `node:crypto`).
