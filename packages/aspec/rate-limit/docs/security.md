# Security

## Threat model

| Threat | Mitigation |
|--------|------------|
| Brute-force / credential stuffing | Tight policies with `failureMode: 'closed'` and penalty-box bans on auth routes |
| IP spoofing via `X-Forwarded-For` | Trusted-proxy parsing only; untrusted hops ignored |
| Store outage opens floodgates | Prefer `failureMode: 'closed'` for sensitive routes; circuit breaker logs and short-circuits |
| API key leakage into Redis | `keys.apiKey()` hashes the secret before it reaches the store |
| Shared IP NAT unfairness | Combine IP limits with user or API-key limits; most restrictive wins |
| Memory exhaustion | Memory store has max entries and TTL cleanup; sliding-log capped at 10k events |

## Secure defaults

- Standard IETF headers on; legacy `X-RateLimit-*` off
- Failure mode open (availability) for general APIs; document closed for auth
- IPv6 clients grouped to /64 by default
- Ban and audit hooks never receive raw API key material from built-in key generators

## Operational guidance

- Put the rate limiter before expensive handlers.
- Log circuit-open events and monitor ban rates.
- Keep Redis and app clocks roughly aligned; the Redis store prefers server `TIME` unless you inject a test clock.
