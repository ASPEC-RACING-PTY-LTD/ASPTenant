# Security

## Threat model

| Threat | Mitigation |
|--------|------------|
| Invitation guessing | Hashed tokens, expiry, throttle, revoke |
| Org lockout | Last-owner protection |
| Cross-tenant reads | ALS + membership check + optional PostgreSQL RLS |
| Privilege escalation | Role map + optional PermissionChecker |
| Reserved slug squatting | Reserved word list on slug validation |

## Secure defaults

- Invitation email match required on accept.
- Delete requires archive first.
- Tokens never appear in audit payloads.
- RLS generator enables `FORCE ROW LEVEL SECURITY` by default.

## Operations

Use a non-superuser database role for application traffic when relying on RLS.
Table owners bypass RLS unless `FORCE` is set (covered in tests).
