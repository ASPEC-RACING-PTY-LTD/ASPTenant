# Security

## Threat model

| Threat | Mitigation |
|--------|------------|
| Token guessing | 256-bit secrets, SHA-256 hashes at rest, constant-time compare |
| Invitation abuse | Expiry, resend throttle, max sends, revoke |
| Privilege escalation | Admin HTTP requires PermissionChecker for `users:*` |
| PII leakage | Audit events omit tokens; purge anonymises or deletes |
| Mass assignment | Typed field definitions; unknown keys rejected |
| Oversized payloads | Body and metadata size limits |

## Secure defaults

- Avatar URLs require `https:` unless `allowHttpAvatars` is enabled.
- Soft delete grace period defaults to 30 days.
- Admin routes fail closed without a PermissionChecker.
- Tokens are never logged or written to audit `changes`.

## Operational guidance

- Put admin routers behind authentication and network controls.
- Prefer SQL stores for multi-instance deployments.
- Register `createPurgeJobHandler` so deletions complete after the grace period.
- Review `user.purging` hooks to remove application data before anonymisation.
- Treat invitation accept URLs as secret capabilities until used.
