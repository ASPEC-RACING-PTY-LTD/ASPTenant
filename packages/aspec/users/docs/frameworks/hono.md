# Hono

```ts
import { Hono } from 'hono';
import { createUsers } from '@aspec/users';
import { createMemoryUsersStore } from '@aspec/users/memory';
import { createUsersAdminApp, createUsersSelfServiceApp } from '@aspec/users/hono';

const users = createUsers({ store: createMemoryUsersStore() });
const app = new Hono();

app.route(
  '/admin',
  createUsersAdminApp(users, {
    async resolveActor(c) {
      const id = c.req.header('x-user-id');
      return id ? { id, type: 'user' } : null;
    },
  }),
);

app.route(
  '/account',
  createUsersSelfServiceApp(users, {
    async resolveActor(c) {
      const id = c.req.header('x-user-id');
      return id ? { id, type: 'user' } : null;
    },
  }),
);
```
