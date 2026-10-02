# Express

Works with Express 4 and 5.

```ts
import express from 'express';
import { createRateLimiter, keys } from '@aspec/rate-limit';
import { createMemoryStore } from '@aspec/rate-limit/memory';
import { rateLimit } from '@aspec/rate-limit/express';

const app = express();
const limiter = createRateLimiter({
  store: createMemoryStore(),
  policy: { name: 'api', limit: 100, windowMs: 60_000 },
});

app.use(
  rateLimit({
    limiter,
    key: keys.ip(),
    trustProxy: 1, // trust one hop (your reverse proxy)
  }),
);
```

The middleware sets `req.rateLimit` to the outcome, writes rate-limit headers, and on rejection responds with `application/problem+json` (429 or 503). Client IP is resolved from the socket and `trustProxy`; Express `app.set('trust proxy')` is not used.
