# Configure

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `RATE_LIMIT_REDIS_URL` | No | Redis-compatible URL when using the Redis store |
| `RATE_LIMIT_KEY_PREFIX` | No | Redis key prefix (default `rl:`) |

## Policy

```ts
createRateLimiter({
  store,
  policy: {
    name: 'api',                 // used in keys and headers
    algorithm: 'sliding-window', // or token-bucket, fixed-window, gcra, sliding-log
    limit: 100,                  // units per window
    windowMs: 60_000,
    burst: 100,                  // token-bucket / gcra capacity (default = limit)
    cost: 1,                     // default cost per consume
  },
  failureMode: 'open',           // 'closed' for auth endpoints
  penalty: { threshold: 5, banMs: 60_000 },
  allowlist: { ips: ['10.0.0.0/8'] },
  denylist: { keys: ['user:banned'] },
});
```

## Algorithms

| Algorithm | Behaviour |
|-----------|-----------|
| `sliding-window` | Weighted counter across the previous and current window. Error bound is one window of traffic under sharp spikes. |
| `token-bucket` | Refills `limit` tokens every `windowMs` up to `burst`. Supports bursts. |
| `gcra` | Generic cell rate algorithm; smooth emission with burst. |
| `fixed-window` | Resets at window boundaries. Can allow up to `2 * limit` at a boundary. |
| `sliding-log` | Exact timestamps. Capped at 10_000 events per key. |

## HTTP options

`createHttpRateLimiter` / adapter options: `rules` (or `limiter` + `key`), `trustProxy`, `proxyHeader`, `ipv6Subnet` (default 64), `allowlist`, `denylist`, `headers.standard` (default true), `headers.legacy`, `headers.retryAfter`, `skip`, `message`, `failureMode` via the underlying limiter.
