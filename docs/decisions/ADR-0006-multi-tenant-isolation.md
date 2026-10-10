# ADR-0006: Multiple tenants with scoped roles and row-level security

## Status
Accepted. Supersedes ADR-0003.

## Date
2026-10-10

## Context
One installation must host several organisations, each with its own domains, mailboxes, users and administrators. ADR-0003 kept a single organisation and put `tenant_id` on product tables, but roles were assigned globally, users were listed from the global directory and audit history was shared. An owner of one organisation would have administered every organisation.

## Decision

### Tenants
- `@aspec/orgs` runs in `multi` mode. A tenant is an organisation. Strategy is `shared`: one database, one schema, a `tenant_id` column on every directory row.
- Accounts are global (one sign-in per email address) and join tenants through memberships. An account can belong to several tenants.
- Each API request is bound to one tenant. The admin UI sends `x-aspectenant-tenant` (organisation id or slug). The HTTP layer accepts it only when the account has an active membership in an active tenant, otherwise no tenant is bound and tenant routes answer 403. Without the header the oldest active membership is used.
- Tenant routes read the tenant from the request context, never from a client-supplied id.

### Roles
- `tenant.owner`, `tenant.admin` and `tenant.auditor` are assignable only in organisation scope. Holding one in tenant A grants nothing in tenant B.
- `platform.operator` is assignable only in global scope. It creates, archives and restores tenants, adds members to them, sets per-tenant limits and may confirm a domain without DNS. It grants no tenant permission: an operator administers a tenant only as a member of that tenant.
- The one exception is `mailboxes:access`, held by platform operators. It lets an operator select any active tenant, without a membership, and open every mailbox of that tenant on the Mailbox page as if it were the owner: read, flag, move, delete and send. The tenant is bound without a membership, so all tenant admin routes still answer 403. Opening a mailbox this way is recorded in that tenant's audit log as `mail.mailbox.operator_access` (at most hourly per operator and mailbox) and every send as `mail.mailbox.operator_sent`.
- Per-tenant limits are installation settings that only platform operators change. `importWorkers` (default 1, 0 pauses, at most 16) is how many PST imports a tenant may run at once. The queue is re-checked every 30 seconds. All import workers run in the API process and share its CPU.
- The setup account becomes platform operator and owner of the first tenant.
- Account-wide changes (profile, sessions, sign-in) by a tenant administrator are refused for accounts that also belong to another tenant. Suspension and removal then affect only the membership in the acting tenant.

### Domains and mail addresses
- Ownership of a domain is proved with the TXT record the Domains page shows (by hand, with Cloudflare or with Domain Connect). Platform operators can confirm without DNS for private networks.
- A partial unique index allows one verified row per hostname across all tenants.
- Mailbox addresses, aliases and group addresses must use a verified domain of their own tenant. Primary addresses and aliases are unique across the installation.

### Mail
- Each tenant has its own ingest token. The token identifies the tenant, and inbound mail is delivered only to that tenant's mailboxes.
- Mail app logins (IMAP, SMTP submission) are bound to one tenant: the tenant that verified the login address's domain when the account is an active member there, otherwise the account's oldest membership. Every command in the session runs bound to that tenant.
- Outbound transport, Cloudflare DNS tokens and the ingest token are tenant settings. The public URL, mail app listeners, updates, backups and Domain Connect are installation settings, stored under the `__platform__` scope and changed only by platform operators.
- Webmail and local delivery resolve recipients within the sender's tenant. An address of another tenant on the same installation is external and leaves through the outbound transport.

### Database isolation
- Every directory and mail table (groups, domains, mailboxes, aliases, delegations, applications, settings, messages, folders, jobs) has PostgreSQL row-level security with `FORCE ROW LEVEL SECURITY`. Policies compare `tenant_id` to `current_setting('app.tenant_id')`.
- The binding `*` lets installation code see every tenant: backup, restore and the import queue use it. Request handlers never bind it.
- Long background work (mailbox imports) runs with a tenant context but no open transaction; each query binds the tenant for itself.
- Each tenant-bound request runs in one transaction that sets `app.tenant_id` locally. A query that forgets its tenant filter still sees only the current tenant, and a row for another tenant cannot be written.
- The API connects as `aspectenant_app`, a non-superuser role without `BYPASSRLS`. Compose creates it on every start (`deploy/postgres/app-role.sql`) and hands existing tables to it. Diagnostics report whether RLS is enforced for the current connection.

## Alternatives considered

### Schema or database per tenant
Stronger physical separation, but every migration and connection pool multiplies by the tenant count. The vendored orgs module supports both strategies if a later deployment needs them.

### A separate account per tenant
Simpler isolation of profiles, but one person in two organisations would need two sign-ins and two passwords. Rejected in favour of memberships plus the exclusive-member rule for account-wide changes.

### Rely only on tenant filters in queries
One missed `WHERE tenant_id` would leak data. Row-level security is kept as the second line.

## Consequences
- Upgrades move global tenant role assignments into the scope of each organisation the subject belongs to, and make former owners platform operators.
- Mailbox records are created for a new user only when their address is on a verified domain of the tenant.
- Future mail ingest needs an explicit, audited lookup from recipient address to tenant, because row-level security hides other tenants' addresses from tenant-bound queries.
- Audit events are written in the request transaction. The audit hash chain head is kept in memory, so request handlers do not roll back their transaction on error responses.
