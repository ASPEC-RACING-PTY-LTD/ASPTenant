# Integrate

## Core only

```ts
import { createRateLimiter } from '@aspec/rate-limit';
import { createMemoryStore } from '@aspec/rate-limit/memory';

const limiter = createRateLimiter({
  store: createMemoryStore(),
  policy: { name: 'ops', limit: 10, windowMs: 1000 },
});

const decision = await limiter.consume('user:42');
if (!decision.allowed) {
  // decision.retryAfterMs, decision.resetAt
}
```

## Redis store

```ts
import { Redis } from 'ioredis';
import { createRateLimiter } from '@aspec/rate-limit';
import { createRedisStore, fromIoredis } from '@aspec/rate-limit/redis';

const redis = new Redis(process.env.RATE_LIMIT_REDIS_URL!);
const store = createRedisStore({
  client: fromIoredis(redis),
  keyPrefix: process.env.RATE_LIMIT_KEY_PREFIX ?? 'rl:',
});
const limiter = createRateLimiter({ store, policy: { name: 'api', limit: 100, windowMs: 60_000 } });
```

Use `fromNodeRedis` for the `redis` package client.

## Key generators

```ts
import { keys } from '@aspec/rate-limit';

keys.ip()                          // per client IP (IPv6 /64 by default)
keys.user()                        // req.user.id / sub / userId
keys.apiKey()                      // X-API-Key or Bearer (hashed)
keys.route(keys.ip())              // method+path combined with another key
keys.custom('org', (req) => ...)   // custom prefix
```

## Multiple policies

Pass several rules; the most restrictive decision wins (first denial ends evaluation, otherwise lowest remaining ratio).

```ts
createHttpRateLimiter({
  rules: [
    { limiter: ipLimiter, key: keys.ip() },
    { limiter: userLimiter, key: keys.user() },
  ],
});
```
