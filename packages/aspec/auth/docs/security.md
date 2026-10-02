# Security

## Threat model

Attackers may attempt credential stuffing, password spraying, session theft, CSRF on cookie sessions, refresh-token theft/reuse, MFA bypass, OIDC mix-up, and WebAuthn origin spoofing.

## Controls

- Passwords: scrypt PHC (`ln=17,r=8,p=1` by default), constant-time verify, optional HIBP k-anonymity
- Sessions: opaque 32-byte tokens stored as SHA-256; idle and absolute timeouts; rotation on privilege and password change
- Cookies: `__Host-` prefix when Secure, HttpOnly, SameSite=Lax, Path=/
- Refresh tokens: hashed at rest, rotated every use, family revocation on reuse with audit event
- Login: rate limits by IP and email; lockout with exponential backoff
- CSRF: Origin (Referer fallback) allow-list for state-changing cookie requests
- MFA: TOTP secrets encrypted with AES-256-GCM; recovery codes hashed; challenge tokens single-use
- OIDC: PKCE S256, bound state/nonce, ID token validation (iss, aud, exp, nonce, azp); no email auto-link unless explicitly enabled and the provider asserts a verified email
- WebAuthn: single-use challenges, counter checks via `@simplewebauthn/server`
- Audit: category `security`, never includes secrets or raw tokens

## Lockout reveal policy

`revealLockedState` defaults to `after-valid-password`: locked/disabled accounts only receive specific errors after a correct password, reducing account enumeration while still informing legitimate users.

## Operations

- Rotate `AUTH_SECRET` / JWT keys carefully (HS256 rotation requires dual verification; prefer asymmetric keys with `kid`)
- Schedule `auth.purgeExpired()` for SQL stores
- Keep `AUTH_ENCRYPTION_KEY` backed up; without it MFA secrets cannot be decrypted
- Restrict `AUTH_ALLOWED_ORIGINS` to exact browser origins
