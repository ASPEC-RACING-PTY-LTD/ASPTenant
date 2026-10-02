# @aspec/rate-limit

Request and operation rate limiting for Node.js. Token bucket, sliding window (counter and log), fixed window and GCRA algorithms; in-memory and Redis-compatible stores; IETF `RateLimit` headers; penalty-box bans; allow and deny lists; Express, Fastify, Hono and Fetch adapters.

## Install

```bash
pnpm add @aspec/rate-limit
```

## Quick start

```ts
import { createRateLimiter } from '@aspec/rate-limit';
import { createMemoryStore } from '@aspec/rate-limit/memory';
import { rateLimit } from '@aspec/rate-limit/express';
import { keys } from '@aspec/rate-limit';

const store = createMemoryStore();
const limiter = createRateLimiter({
  store,
  policy: { name: 'api', limit: 100, windowMs: 60_000 },
});

app.use(rateLimit({ limiter, key: keys.ip(), trustProxy: 1 }));
```

## Docs

- [Summary](docs/summary.md)
- [Install](docs/install.md)
- [Configure](docs/configure.md)
- [Integrate](docs/integrate.md)
- [API](docs/api.md)
- [Security](docs/security.md)
- [AI agent guide](docs/ai.md)

## Licence

MIT
