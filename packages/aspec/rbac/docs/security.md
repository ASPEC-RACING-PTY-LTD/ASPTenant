# Security

## Threat model

| Threat | Mitigation |
|--------|------------|
| Privilege escalation via admin API | `preventEscalation` (default on); admin routes require `rbac:admin` |
| Existence leaks for cross-tenant probes | Scoped admin checks may answer 403 instead of 404 |
| Client-side permission bypass | React guards are UX only; always re-check on the server |
| Unsafe ABAC | No `eval`, no regex from input; bounded depth/size; own-property lookups only |
| Cache poisoning / stale allows | Cache failures are misses; generation bump on bulk changes; TTL bounds staleness |
| Secret leakage in audit | Never put secrets in audit metadata; 403 bodies omit permission names |

## Secure defaults

- Default deny.
- Deny overrides allow at every layer.
- System definition entries are immutable via admin.
- Registered permissions required for new patterns.
- Actors cannot hand out permissions they do not hold.

## Operational guidance

- Prefer organisation-scoped admin actors for multi-tenant apps.
- Sample denied-access audit events under load (`auditDenied: { sampleRate }`).
- Treat assignment cache as eventually consistent across processes; call `invalidate` after out-of-band store writes.
- Keep SQL credentials in environment variables, not in `config.schema.json` documents checked into source control.
