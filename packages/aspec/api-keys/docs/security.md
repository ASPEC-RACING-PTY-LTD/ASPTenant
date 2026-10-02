# Security

## Threat model

| Threat | Mitigation |
|--------|------------|
| Stolen database rows | Only HMAC-SHA256(pepper, key) stored |
| Timing oracles on verify | Constant-time hash compare; dummy compare for unknown IDs |
| Pepper leakage | Env-only; refuse production start without 32+ byte pepper |
| Scope escalation via admin API | Escalation guard unless explicitly allowed |
| Secret scanning | Documented API_KEY_SCAN_REGEX |

## Secure defaults

90-day expiry, CRC32 offline recognition, no plaintext after create, sampled verification_failed audits.
