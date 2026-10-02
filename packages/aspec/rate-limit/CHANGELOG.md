# Changelog

## [1.0.0] - 2026-09-29

Initial release.

- Algorithms: sliding-window counter, token-bucket, fixed-window, GCRA, sliding-log
- Stores: bounded memory store; Redis-compatible store with `EVALSHA` and `NOSCRIPT` fallback
- Structural adapters for ioredis and node-redis
- `createRateLimiter` implementing `RateLimiterLike`, plus `peek`, `reset`, `penalize`, `limit`, ban APIs
- HTTP helpers with IETF `RateLimit-Policy` / `RateLimit` headers, optional legacy headers, `Retry-After`
- Abuse prevention: penalty box, allow and deny lists (IP, CIDR, keys)
- Failure modes open/closed with circuit breaker
- Middleware for Express 4/5, Fastify, Hono and Fetch
