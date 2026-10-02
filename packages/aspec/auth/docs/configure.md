# Configure

## Environment variables

| Name | Required | Description |
|------|----------|-------------|
| `AUTH_SECRET` | When issuing HS256 access tokens | At least 32 UTF-8 bytes |
| `AUTH_ENCRYPTION_KEY` | When MFA is enabled | Base64 32-byte AES key for TOTP secrets |
| `AUTH_JWT_PRIVATE_KEY` | Optional | PEM PKCS#8 or JWK for EdDSA/ES256 |
| `AUTH_JWT_ALG` | Optional | `EdDSA` (default) or `ES256` |
| `AUTH_JWT_KID` | Optional | Key id for JWT headers / JWKS |
| `AUTH_APP_URL` | Recommended | Public base URL for links and OIDC redirects |
| `AUTH_ALLOWED_ORIGINS` | For cookie HTTP | Comma-separated origins for CSRF checks |
| `AUTH_WEBAUTHN_RP_ID` | For WebAuthn | Relying party ID |
| `AUTH_WEBAUTHN_RP_NAME` | Optional | Display name |
| `AUTH_WEBAUTHN_ORIGIN` | For WebAuthn | Comma-separated expected origins |
| `OIDC_*_CLIENT_ID` / `OIDC_*_CLIENT_SECRET` | Per provider | Application-defined names |

Use `readAuthEnv(process.env)` and `signingFromEnv(env)` from `@aspec/auth` to parse these safely.

## Factory options (`createAuth`)

| Option | Default | Notes |
|--------|---------|-------|
| `store` | required | `AuthStore` implementation |
| `mailer` | none | Without a mailer, reset/verification tokens are returned to the caller |
| `rateLimiter` | built-in memory | `RateLimiterLike` |
| `audit` | none | `AuditSink`; secrets are never recorded |
| `hasher` | scrypt ln=17 | `PasswordHasher` |
| `session.*` | 24h idle / 30d absolute | Milliseconds |
| `tokens` | disabled | Enables JWT + refresh tokens |
| `lockout` | 5 failures, exponential | See `revealLockedState` trade-offs in security.md |
| `mfa.encryptionKey` | unset | Enables TOTP |
| `passwordPolicy` | min 12 / max 128 | Optional `isPasswordCompromised` (for example `@aspec/auth/hibp`) |
| `links.passwordReset` / `emailVerification` | required with mailer | Absolute URL base or `(token) => url` |

Serialisable subset: `config.schema.json`.
