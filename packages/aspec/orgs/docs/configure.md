# Configure

`createOrgs(options)` requires `mode` (`single` | `multi`) and `store`.

## Ports

| Option | When omitted |
|--------|--------------|
| `mailer` | Invitation tokens returned for manual delivery |
| `audit` | No audit events |
| `permissions` | Role map only (`DEFAULT_ROLE_PERMISSIONS`) |
| `logger` / `clock` / `generateId` | No-op / `Date.now` / UUID v7 |

## Behaviour

| Option | Default | Notes |
|--------|---------|-------|
| `settings` | `{}` | Typed org settings |
| `rolePermissions` | owner/admin/member map | Org-scoped permissions |
| `customRoles` | `[]` | Extra role keys |
| `invitations.ttlMs` | 7d | Invite lifetime |
| `invitations.requireEmailMatch` | `true` | Accept email must match |
| `tenant.defaultStrategy` | `shared` | `shared` / `schema` / `database` |
| `tenant.onSchemaProvision` | unset | Required app hook for schema strategy migrations |
| `tenant.onDatabaseProvision` | unset | Required for database strategy |
| `single.id/name/slug` | `default` | Single-tenant default org |

Env vars used by templates: `ORGS_MODE`, `ORGS_ACCEPT_URL`, `ORGS_APP_NAME`,
`ORGS_DATABASE_URL`.
