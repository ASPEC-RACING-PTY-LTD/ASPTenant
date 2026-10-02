# Fetch handler

Returns `(request: Request) => Promise<Response>`. Suitable for runtimes that
expose the Fetch API (tested on Node 24).

```ts
import { createUsers } from '@aspec/users';
import { createMemoryUsersStore } from '@aspec/users/memory';
import {
  createUsersAdminHandler,
  createUsersSelfServiceHandler,
} from '@aspec/users/fetch';

const users = createUsers({ store: createMemoryUsersStore() });

export const adminHandler = createUsersAdminHandler(users, {
  basePath: '/admin',
  async resolveActor(req) {
    const id = req.headers.get('x-user-id');
    return id ? { id, type: 'user' } : null;
  },
});

export const selfServiceHandler = createUsersSelfServiceHandler(users, {
  basePath: '/account',
  async resolveActor(req) {
    const id = req.headers.get('x-user-id');
    return id ? { id, type: 'user' } : null;
  },
});
```
