# Summary

`@aspec/auth` is a portable authentication service for Node.js. It owns credentials and sessions, not user profiles. Use it when you need email and password sign-in, secure hashing, password reset, email verification, session and refresh-token management, lockout, audit events, and optional TOTP, OAuth/OIDC or WebAuthn. Pair it with `@aspec/users` (or your own users table) by sharing the account `id`. Prefer a dedicated identity provider only when that is already a hard requirement for your organisation.
