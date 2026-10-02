# Security

## Threat model

`@aspec/testing` runs in development and CI. Risks:

1. **Test secrets leaking into production** if JWT secrets, cookie secrets or database URLs are copied into runtime config.
2. **Global `fetch` left mocked** when a test forgets to restore, causing later tests or tools to hit the mock.
3. **Seeded `Random` mistaken for cryptography**, producing predictable tokens if misused for secrets.
4. **SQL identifier injection** if table names were taken from user input (helpers reject non-identifiers).

## Secure defaults

- JWT helpers use `node:crypto` (HS256 HMAC, ES256 P-256). HS256 secrets must be at least 32 bytes. Verification uses an algorithm allow-list derived from key material, not the token header alone. Signature compares use `timingSafeEqual` for HS256.
- Cookie signature verification is constant-time.
- `Random` / factories are explicitly non-cryptographic; JWT and cookie secrets use `crypto.randomBytes`.
- `mockFetch` restores `globalThis.fetch` via `restore()`, `Symbol.dispose` or `cleanupAll()`.
- `withEnv` / `isolateEnv` restore `process.env` exactly, including deletions.
- Temp directories reject path escape. Mock server defaults to loopback and a 1 MiB body limit.
- PostgreSQL fixtures create disposable schemas and drop them on close.

## Operational guidance

- Install only as a development dependency (`dependencyType: dev`).
- Never reuse `createTestJwtSigner` secrets or ASPEC test database credentials in production.
- Prefer `using mock = mockFetch()` or always call `cleanupAll()` in `afterEach`.
- Treat `ASPEC_TEST_POSTGRES_URL` as sensitive in shared CI logs.
