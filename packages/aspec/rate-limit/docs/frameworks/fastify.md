# Fastify

```ts
import Fastify from 'fastify';
import { createRateLimiter, keys } from '@aspec/rate-limit';
import { createMemoryStore } from '@aspec/rate-limit/memory';
import { fastifyRateLimit } from '@aspec/rate-limit/fastify';

const app = Fastify();
const limiter = createRateLimiter({
  store: createMemoryStore(),
  policy: { name: 'api', limit: 100, windowMs: 60_000 },
});

await app.register(fastifyRateLimit, {
  limiter,
  key: keys.ip(),
  trustProxy: 1,
});

app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));

app.get(
  '/expensive',
  {
    config: {
      rateLimit: {
        limiter: createRateLimiter({
          store: createMemoryStore(),
          policy: { name: 'expensive', limit: 5, windowMs: 60_000 },
        }),
        key: keys.user(),
      },
    },
  },
  async () => ({ ok: true }),
);
```

Set `global: false` to limit only routes that declare `config.rateLimit`. The outcome is on `request.rateLimit`.
