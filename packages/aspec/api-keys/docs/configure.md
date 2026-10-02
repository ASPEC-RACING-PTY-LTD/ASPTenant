# Configure

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `API_KEYS_PEPPER` | Production | HMAC pepper, at least 32 bytes. Required when `NODE_ENV=production`. |
| `API_KEYS_PREFIX` | No | Key prefix ending with `_`. Default `ak_live_`. |

## Options

`createApiKeys({ store, pepper, cache, rateLimiter, audit, logger, clock, prefix, defaultTtlMs, maxTtlMs, scopeCatalogue })`

Default TTL is 90 days; max TTL is 365 days. Pass `neverExpires: true` to opt out of expiry.
