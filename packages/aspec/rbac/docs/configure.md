# Configure

Pass options to `createRbac(options)`. Serialisable configuration (definition plus options) is validated by `loadRbacConfig` / `config.schema.json`.

## Engine options

| Option | Default | Description |
|--------|---------|-------------|
| `store` | memory | `RbacStore` (`./memory` or `./sql`) |
| `definition` | none | `defineRbac({ permissions, roles, ownership, policies })` |
| `pruneDefinition` | `true` | Remove obsolete system entries on seed |
| `cache` | none | `CacheLike` for assignment lookups |
| `cacheTtlMs` | `60000` | Assignment cache TTL |
| `cacheKeyPrefix` | `rbac:` | Cache key prefix |
| `audit` | none | `AuditSink` for admin mutations |
| `auditDenied` | `false` | Sample `rbac.access.denied` (`true` or `{ sampleRate }`) |
| `auditFailure` | `log` | `log` or `throw` when the sink fails |
| `orgRolesApplyToTeams` | `true` | Org assignments apply in that org's teams |
| `staticRoles` | `auto` | How `subject.roles` apply: `auto`, `global`, `ignore` |
| `catalogTtlMs` | `30000` | Catalogue reload interval (`0` disables TTL) |
| `adminPermission` | `rbac:admin` | Mutation permission for the admin HTTP API |
| `adminReadPermission` | same as admin | Read permission for the admin HTTP API |
| `requireRegisteredPermissions` | `true` | New patterns must be registered |
| `preventEscalation` | `true` | Actors cannot grant permissions they lack |
| `timeZone` | `UTC` | Time zone for `context.time` in policies |
| `limits` | see API | Caps for assignments, roles, snapshot grants |

## Environment variables

| Name | Required | Description |
|------|----------|-------------|
| `RBAC_DATABASE_URL` | for SQL | PostgreSQL URL (application wiring) |
| `RBAC_TABLE_PREFIX` | no | SQL table prefix (default `rbac_`) |

Secrets never belong in the definition JSON; keep database credentials in the environment.
