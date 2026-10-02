# Changelog

## [1.0.0] - 2026-09-29

### Added

- Email and password authentication with scrypt PHC hashing and password policy
- Opaque sessions, cookie helpers, JWT access tokens and rotating refresh tokens
- Password reset and email verification (no enumeration)
- Login rate limiting and account lockout with exponential backoff
- TOTP MFA (RFC 6238) with encrypted secrets and recovery codes
- OAuth 2.0 / OpenID Connect adapter (`@aspec/auth/oidc`) with Google, Microsoft and GitHub presets
- WebAuthn passkeys (`@aspec/auth/webauthn`) via `@simplewebauthn/server`
- Have I Been Pwned checker (`@aspec/auth/hibp`)
- Memory and SQL stores (PostgreSQL and SQLite) with migrations
- Express 4/5, Fastify 5, Hono 4 and Fetch HTTP adapters with CSRF origin checks
