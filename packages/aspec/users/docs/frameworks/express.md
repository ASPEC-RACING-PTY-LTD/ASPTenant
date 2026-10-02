# Express

Works with Express 4 and 5. Mount admin and self-service routers separately.

```ts
import express from 'express';
import { createUsers } from '@aspec/users';
import { createMemoryUsersStore } from '@aspec/users/memory';
import {
  createUsersAdminRouter,
  createUsersSelfServiceRouter,
} from '@aspec/users/express';

const users = createUsers({ store: createMemoryUsersStore() });
const app = express();

app.use(
  '/admin',
  createUsersAdminRouter(users, {
    async resolveActor(req) {
      const id = req.headers['x-user-id'];
      return typeof id === 'string' ? { id, type: 'user' } : null;
    },
  }),
);

app.use(
  '/account',
  createUsersSelfServiceRouter(users, {
    async resolveActor(req) {
      const id = req.headers['x-user-id'];
      return typeof id === 'string' ? { id, type: 'user' } : null;
    },
  }),
);
```

Admin routes require a `PermissionChecker` on the service (permissions
`users:read`, `users:update`, `users:suspend`, `users:delete`, `users:invite`).
Self-service routes use the resolved actor as the target user (`/me`).
Public routes include activation and invitation accept.
