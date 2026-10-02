# Fastify

```ts
import Fastify from 'fastify';
import { createUsers } from '@aspec/users';
import { createMemoryUsersStore } from '@aspec/users/memory';
import {
  createUsersAdminPlugin,
  createUsersSelfServicePlugin,
} from '@aspec/users/fastify';

const users = createUsers({ store: createMemoryUsersStore() });
const app = Fastify();

await app.register(createUsersAdminPlugin(users, {
  async resolveActor(req) {
    const id = req.headers['x-user-id'];
    return typeof id === 'string' ? { id, type: 'user' } : null;
  },
}), { prefix: '/admin' });

await app.register(createUsersSelfServicePlugin(users, {
  async resolveActor(req) {
    const id = req.headers['x-user-id'];
    return typeof id === 'string' ? { id, type: 'user' } : null;
  },
}), { prefix: '/account' });
```
