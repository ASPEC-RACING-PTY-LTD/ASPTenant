# Fastify

```ts
import Fastify from 'fastify';
import { createAuth, readAuthEnv } from '@aspec/auth';
import { createMemoryAuthStore } from '@aspec/auth/memory';
import { createAuthPlugin, getAuth } from '@aspec/auth/fastify';

const env = readAuthEnv(process.env);
const auth = createAuth({ store: createMemoryAuthStore() });
const plugin = createAuthPlugin(auth, {
  basePath: '/auth',
  allowedOrigins: env.allowedOrigins,
});

const app = Fastify();
await app.register(plugin);
app.get('/me', { preHandler: plugin.requireAuth() }, async (request) => getAuth(request).account);
```

The plugin registers an encapsulated raw body parser limited to `maxBodyBytes`.
