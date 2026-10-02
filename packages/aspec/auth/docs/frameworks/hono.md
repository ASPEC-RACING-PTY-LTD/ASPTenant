# Hono

```ts
import { Hono } from 'hono';
import { createAuth, readAuthEnv } from '@aspec/auth';
import { createMemoryAuthStore } from '@aspec/auth/memory';
import { createAuthRoutes, type AuthVariables } from '@aspec/auth/hono';

const env = readAuthEnv(process.env);
const auth = createAuth({ store: createMemoryAuthStore() });
const routes = createAuthRoutes(auth, {
  basePath: '/auth',
  allowedOrigins: env.allowedOrigins,
});

const app = new Hono<{ Variables: AuthVariables }>();
app.route('/', routes.app);
app.get('/me', routes.requireAuth(), (c) => c.json(c.get('auth')?.account));
```
