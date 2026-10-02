# Security

## Threat model

| Threat | Mitigation |
|--------|------------|
| Secrets in audit payloads | Deep redaction of keys and value patterns before hash/storage |
| Silent log tampering | Per-stream hash chain; optional HMAC so DB writers cannot recompute |
| Retention destroying evidence of tampering | Retention checkpoints (HMAC / Ed25519) anchor remaining events |
| Public admin API | Require `authorize` or `PermissionChecker`; never mounts open |
| Client IP spoofing | `trustProxy` defaults to false; validate hops explicitly |
| Request ID injection | Incoming IDs must match a strict pattern |
| SQL injection | Parameterised queries; validated `tablePrefix` identifiers only |

## Secure defaults

- Redaction enabled with password/token/key detectors and Luhn card checks.
- Admin router construction fails without an authorisation hook.
- JSONL files default to mode `0o600`.
- HMAC and signing keys are optional but recommended in production.

## Operations

1. Store `AUDIT_HMAC_KEY` in a secret manager (≥32 random bytes).
2. Prefer SQL with HMAC for multi-instance deployments.
3. On PostgreSQL, install `installAppendOnlyTrigger` and revoke DELETE from the app role.
4. Run `verifyAll()` on a schedule; alert on `ok: false`.
5. Never log chain keys, and never put secrets in `metadata` intentionally.
