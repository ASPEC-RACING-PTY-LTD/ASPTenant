# API

## `@aspec/rate-limit`

### `createRateLimiter(options): RateLimiter`

Options: `store`, `policy`, `failureMode` (`open`|`closed`), `circuitBreaker`, `penalty`, `checkBans`, `allowlist`, `denylist`, `onLimitReached`, `onBan`, `audit`, `logger`, `clock`.

Methods: `consume(key, cost?)`, `peek(key)`, `reset(key)`, `penalize(key, cost?)`, `limit(key, cost?)` (throws `RateLimitExceededError`), `ban(key, durationMs?)`, `unban(key)`, `getBan(key)`, `circuitState`, `policy`.

Implements `RateLimiterLike.consume`.

### Algorithms

`ALGORITHMS`, `normalizePolicy`, `applyAlgorithm`, `policyWindowSeconds`, types `RateLimitPolicy`, `RateLimitPolicyInput`, `Algorithm`.

### HTTP

`createHttpRateLimiter(options)`, `keys`, `formatStandardHeaders`, `mostRestrictive`, `PROBLEM_CONTENT_TYPE`, `problemBody`, `nodeHeaderReader`, `pathOf`.

### Errors

`RateLimitError`, `RateLimitExceededError` with codes `RATE_LIMIT_INVALID_CONFIG`, `RATE_LIMIT_INVALID_ARGUMENT`, `RATE_LIMIT_EXCEEDED`, `RATE_LIMIT_STORE_ERROR`.

### Ports

`RateLimiterLike`, `RateLimitDecision`, `LoggerLike`, `AuditSink`, `Clock` (structural).

### IP helpers

`AccessList`, `IpSet`, `normalizeIp`, `ipKey`, `createClientIpResolver`, `parseXForwardedFor`, `parseForwarded`.

## `@aspec/rate-limit/memory`

`createMemoryStore(options?)`: bounded store with optional `maxEntries`, `clock`, unref'd TTL cleanup. Returns `close()`.

## `@aspec/rate-limit/redis`

`createRedisStore({ client, keyPrefix?, clock? })`, `fromIoredis(client)`, `fromNodeRedis(client)`.

## `@aspec/rate-limit/express`

`rateLimit(options | HttpRateLimiter): ExpressRateLimitMiddleware`

## `@aspec/rate-limit/fastify`

Default export: Fastify plugin. Route config `rateLimit: false | HttpRateLimitOptions`.

## `@aspec/rate-limit/hono`

`rateLimit(options): MiddlewareHandler`

## `@aspec/rate-limit/fetch`

`createFetchRateLimiter(options): FetchRateLimiter` with `check`, `rejection`, `applyHeaders`, and `wrap(handler)`.
