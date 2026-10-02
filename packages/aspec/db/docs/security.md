# Security

## Threat model

| Threat | Mitigation |
|--------|------------|
| Credential leakage in logs/errors | `redactUrl` / `redactText` on CLI and errors; config errors never echo passwords |
| Credential leakage via query hooks | Parameters redacted unless `logParameters: true` |
| SQL injection | Positional parameters only; never concatenate user input into SQL |
| MITM to PostgreSQL | Prefer `verify-full` with a CA; `require` encrypts without verifying |
| Accidental production seeding | Refused when `NODE_ENV=production` unless forced |
| Migration tampering after apply | SHA-256 checksums refuse changed applied SQL |

## Defaults

- SQLite foreign keys on; WAL for files; busy timeout 5s.
- Pool connection/idle timeouts 10s.
- Health timeout 2s.
- Instrumentation does not log parameters.

## Operations

Store `DATABASE_URL` in a secret manager. Rotate database passwords and update the URL. Restrict DB roles used by the application. Do not enable `logParameters` in production.
