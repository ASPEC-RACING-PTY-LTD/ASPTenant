# Hono

```ts
import { Hono } from 'hono';
import { createRateLimiter, keys } from '@aspec/rate-limit';
import { createMemoryStore } from '@aspec/rate-limit/memory';
import { rateLimit } from '@aspec/rate-limit/hono';

const app = new Hono();
const limiter = createRateLimiter({
  store: createMemoryStore(),
  policy: { name: 'api', limit: 100, windowMs: 60_000 },
});

app.use(
  '*',
  rateLimit({
    limiter,
    key: keys.ip(),
    trustProxy: 1,
  }),
);
```

With `@hono/node-server`, the peer address is read from `c.env.incoming.socket.remoteAddress`. On other runtimes pass `getRemoteAddress`. The outcome is available as `c.get('rateLimit')`.
