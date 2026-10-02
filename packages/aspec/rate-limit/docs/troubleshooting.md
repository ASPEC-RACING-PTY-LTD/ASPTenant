# Troubleshooting

## `RATE_LIMIT_INVALID_CONFIG`

Invalid options (policy name, algorithm, limit, window, failure mode, penalty fields). Check the `details.option` field on the error.

## `RATE_LIMIT_INVALID_ARGUMENT`

Empty or oversized key, or non-positive cost. Keys must be non-empty strings of at most 512 characters.

## `RATE_LIMIT_EXCEEDED`

Thrown by `limiter.limit()` when the decision is denied. Read `error.decision.retryAfterMs` and `error.status` (429 or 503).

## `RATE_LIMIT_STORE_ERROR`

Wrapped Redis or store failure when surfaced through store helpers. With `failureMode: 'open'` consume returns allow with reason `fail_open`; with `closed` it denies with reason `store_unavailable` (HTTP 503).

## All clients share one bucket

The peer IP is unknown. Pass `trustProxy` / proxy headers correctly, or provide `getRemoteAddress` (Hono/Fetch). Without an IP, keys use `ip:unknown`.

## Spoofed `X-Forwarded-For`

Only trust proxy hops you control. Set `trustProxy` to the number of reverse proxies in front of the app (or a CIDR list of trusted proxies). Untrusted forwarded headers are ignored.

## Redis `NOSCRIPT`

Expected on first use or after `SCRIPT FLUSH`. The store loads scripts and retries via `EVALSHA`.
