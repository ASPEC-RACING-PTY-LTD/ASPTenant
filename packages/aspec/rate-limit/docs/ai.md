# AI agent guide

## Purpose

Reusable rate limiting for requests and operations with memory or Redis stores and HTTP adapters.

## Use when

- Throttling by IP, user, API key or custom key
- Distributed limits across Node processes (Redis store)
- Abuse prevention with bans and allow/deny lists

## Avoid when

- You need billing quotas with invoices
- You only need a mutex or concurrency semaphore

## Prerequisites

Node.js >= 22.13. Optional: Express, Fastify, Hono, ioredis or redis.

## Integration steps

1. Install `@aspec/rate-limit` and any framework peer.
2. Create a store: `createMemoryStore()` or `createRedisStore({ client: fromIoredis(redis) })`.
3. Create a limiter: `createRateLimiter({ store, policy: { name, limit, windowMs } })`.
4. For HTTP, mount the adapter (`@aspec/rate-limit/express` and so on) with `key: keys.ip()` and `trustProxy` when behind a proxy.
5. For auth routes set `failureMode: 'closed'` and consider `penalty`.

## Configuration

- Env: `RATE_LIMIT_REDIS_URL`, `RATE_LIMIT_KEY_PREFIX`
- Policy fields: `name`, `algorithm`, `limit`, `windowMs`, `burst`, `cost`
- HTTP: `trustProxy`, `headers`, `allowlist`, `denylist`, `skip`

## Verification

```bash
pnpm --filter @aspec/rate-limit test
pnpm --filter @aspec/rate-limit typecheck
```

Expect tests to pass. With Redis URL set, Redis store tests run; without it they skip.

## Common mistakes

- Forgetting `trustProxy` behind a load balancer (everyone shares one IP or spoofed IPs work)
- Using fail-open on login endpoints
- Passing raw API keys as store keys instead of `keys.apiKey()`

## Uninstall

Remove adapter registration and the package; flush Redis prefix if desired.
