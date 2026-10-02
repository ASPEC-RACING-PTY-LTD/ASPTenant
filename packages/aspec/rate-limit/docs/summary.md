# Summary

`@aspec/rate-limit` limits how often a client may perform an operation. Create a store (memory or Redis-compatible), build a named policy with `createRateLimiter`, then consume units with `consume`, `peek`, `reset`, `penalize` or `limit`. HTTP adapters emit IETF `RateLimit` headers and return RFC 9457 problem+json on 429. Optional penalty-box bans, allow/deny lists and fail-open or fail-closed store handling support abuse prevention.
