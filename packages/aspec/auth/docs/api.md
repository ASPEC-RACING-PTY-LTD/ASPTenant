# API

## `@aspec/auth`

| Export | Description |
|--------|-------------|
| `createAuth(options)` | Creates the authentication service |
| `AuthError` / `AUTH_ERROR_CODES` / `isAuthError` | Module errors (`code`, `status`, `expose`) |
| `createScryptHasher` / `createPasswordPolicy` | Password hashing and policy |
| `createAccessTokenIssuer` | JWT access tokens (also used internally via `tokens`) |
| `readAuthEnv` / `signingFromEnv` | Environment helpers |
| Cookie helpers | `sessionCookie`, `clearSessionCookie`, `parseCookies`, `resolveCookieOptions` |
| TOTP helpers | `generateTotp`, `verifyTotp`, `buildOtpauthUri`, `generateRecoveryCodes` |
| `createAuthHttpHandler` | Framework-neutral HTTP layer |
| Ports | `SqlClient`, `Mailer`, `AuditSink`, `RateLimiterLike`, `LoggerLike`, `Clock` |

### `createAuth` methods (selected)

`register`, `login`, `completeMfaChallenge`, `signIn`, `authenticateSession`, `authenticateAccessToken`, `logout`, `refresh`, `issueTokens`, `rotateSession`, `listSessions`, `revokeSession`, `revokeAllSessions`, `changePassword`, `requestPasswordReset`, `resetPassword`, `sendEmailVerification`, `verifyEmail`, `changeEmail`, `getAccount`, `unlockAccount`, `disableAccount`, `enableAccount`, `deleteAccount`, `beginTotpEnrollment`, `confirmTotpEnrollment`, `disableTotp`, `regenerateRecoveryCodes`, `getMfaStatus`, `jwks`, `purgeExpired`, `idle`.

## Subpaths

| Subpath | Exports |
|---------|---------|
| `./memory` | `createMemoryAuthStore` |
| `./sql` | `createSqlAuthStore`, `migrate`, `migrations`, `createMigrations`, `tableNames` |
| `./express` | `createAuthRouter`, `getAuth` |
| `./fastify` | `createAuthPlugin`, `getAuth` |
| `./hono` | `createAuthRoutes` |
| `./fetch` | `createAuthFetchHandler` |
| `./oidc` | `createOidc`, `oidcPreset` |
| `./webauthn` | `createWebAuthn` |
| `./hibp` | `createHibpChecker` |
