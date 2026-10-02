# Express

Works with Express 4 and Express 5.

```ts
import express from 'express';
import { createAuth, readAuthEnv } from '@aspec/auth';
import { createMemoryAuthStore } from '@aspec/auth/memory';
import { createAuthRouter, getAuth } from '@aspec/auth/express';

const env = readAuthEnv(process.env);
const auth = createAuth({ store: createMemoryAuthStore() });
const router = createAuthRouter(auth, {
  basePath: '/auth',
  allowedOrigins: env.allowedOrigins,
  cookie: { secure: true },
});

const app = express();
app.use(router);
app.get('/me', router.requireAuth(), (req, res) => {
  res.json(getAuth(req).account);
});
```

Mount with `app.use(router)`. The router reads JSON bodies itself (size-limited) unless an upstream parser already consumed the stream.
