# Troubleshooting

## API_KEYS_INVALID_CONFIG

Missing/short pepper in production, invalid prefix, or bad TTL options.

## API_KEYS_UNAUTHORIZED (401)

Invalid, revoked, expired, or disabled-owner key. Response never reveals which.

## API_KEYS_SCOPE_DENIED (403)

Key valid but missing required scopes.

## API_KEYS_ESCALATION

Scope update broadens privileges. Pass `allowEscalation: true` from a privileged admin path.

## API_KEYS_RATE_LIMITED (429)

Per-key limit via the injected RateLimiterLike.
