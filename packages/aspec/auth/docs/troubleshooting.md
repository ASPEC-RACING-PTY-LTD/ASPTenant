# Troubleshooting

Organised by `AuthError.code`.

| Code | Meaning | Fix |
|------|---------|-----|
| `AUTH_CONFIG_INVALID` | Bad factory / env options | Read the message; it names the option |
| `AUTH_VALIDATION_FAILED` | Invalid request fields | Check body field names and lengths |
| `AUTH_INVALID_CREDENTIALS` | Wrong email/password (generic) | Do not branch UI on account existence |
| `AUTH_ACCOUNT_LOCKED` | Lockout active | Wait for `retryAfterSeconds` or call `unlockAccount` |
| `AUTH_ACCOUNT_DISABLED` | Admin disabled the account | Call `enableAccount` |
| `AUTH_EMAIL_TAKEN` | Registration conflict | Ask the user to sign in or reset |
| `AUTH_EMAIL_NOT_VERIFIED` | Policy requires verification | Send / complete verification |
| `AUTH_PASSWORD_POLICY` | Too short/long | Enforce min/max lengths client-side too |
| `AUTH_PASSWORD_COMPROMISED` | Failed HIBP (or other) check | Ask for a different password |
| `AUTH_RATE_LIMITED` | Too many attempts | Back off using `retryAfterSeconds` |
| `AUTH_UNAUTHENTICATED` / `AUTH_SESSION_EXPIRED` | Missing or expired session | Re-authenticate |
| `AUTH_INVALID_TOKEN` | Reset / MFA / JWT invalid | Request a new token |
| `AUTH_REFRESH_TOKEN_REUSED` | Refresh reuse detected | Family revoked; full re-login required |
| `AUTH_MFA_*` | MFA enrolment / challenge errors | Confirm MFA is configured and codes are current |
| `AUTH_CSRF_REJECTED` | Origin not allowed | Set `AUTH_ALLOWED_ORIGINS` / `allowedOrigins` |
| `AUTH_OIDC_*` | Provider flow failed | Check client credentials, redirect URI, clocks |
| `AUTH_WEBAUTHN_*` | Passkey ceremony failed | Check rpID/origin and challenge freshness |
| `AUTH_STORE_FULL` | Memory store cap reached | Raise caps or use SQL |
| `AUTH_INTERNAL` | Unexpected failure | Check logs; never expose to clients |
