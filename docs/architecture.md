# ASPECTenant architecture

ASPECTenant is an open-source, self-hosted control plane that hosts one or more organisations (tenants) on one installation, each isolated from the others. It administers identities, access, domains, applications and mail. It does not replace Word, Excel, PowerPoint, OneDrive, SharePoint, Teams, Intune or SoftDock.

## What exists now

The control plane is a working administrative foundation:

- Docker Compose: PostgreSQL, control-plane API, admin UI
- First-time setup of the platform operator and the first tenant
- Multiple tenants: create, archive, restore, add members (platform operators)
- Email/password sessions, session revoke and password change
- RBAC per tenant (`tenant.owner`, `tenant.admin`, `tenant.auditor`) and a global `platform.operator`
- User directory (create, profile, suspend/reinstate)
- Security and distribution groups with membership
- Custom domains verified by DNS TXT record (or Domain Connect / Cloudflare), with MX/SPF/DMARC checks; each verified domain belongs to one tenant
- Mailboxes with stored messages, aliases, delegates and distribution groups
- Inbound mail through Cloudflare Email Routing (Worker to ingest API) and outbound through Cloudflare Email Sending or SMTP, configured per tenant
- Built-in webmail and live mail settings in the panel
- In-app updates through an updater sidecar
- OpenID Connect provider for registered applications at `{public URL}/oidc` (`apps/api/src/oidc`): authorization code with PKCE (S256), `state` and `nonce`, client secrets stored hashed (client_secret_basic or client_secret_post), public clients with loopback redirects, exact redirect URI matching, rotatable RS256 signing keys, `prompt=login` and `max_age`. ID tokens carry sub, email, email_verified, name, auth_time and tid. Applications can require assignment (people or groups) and two-step verification
- Two-step verification (TOTP authenticator apps with recovery codes) on Your account
- Organisation settings
- Searchable audit history
- Health, readiness and system diagnostics

SAML, SCIM, LDAP, passkeys and SoftDock integration are specified, not shipped.

## Component boundaries

```
Internet
  -> reverse proxy (optional, for example Cloudflare Tunnel)
    -> admin UI (apps/web)
    -> control plane API (apps/api)
      -> PostgreSQL
      -> vendored ASPEC modules (packages/aspec)
```

Later inbound mail:

```
Internet MX
  -> inbound transport (Cloudflare Email Routing Worker, or a local MTA)
    -> ASPECTenant ingest API
      -> ASPECTenant mailbox store (not implemented)
```

Later outbound mail:

```
ASPECTenant mailbox
  -> outbound transport (Cloudflare Email Sending, SMTP relay, SES, ...)
    -> Internet
```

| Component | Owns | Must not own |
|-----------|------|--------------|
| `apps/api` | HTTP surface, setup, directory, platform wiring, mail contracts | SoftDock features, mailbox MIME store |
| `apps/web` | Administration shell | Business logic or secrets |
| `packages/aspec/*` | Generic identity, RBAC, audit, SQL, config | ASPECTenant product policy |
| PostgreSQL | Control-plane state | Cloudflare or SoftDock databases |
| Future mail store | Messages, folders, attachments, indexes | Transport credentials of a relay |
| SoftDock | Its own product | ASPECTenant identity store |

## Data ownership

The organisation that runs ASPECTenant owns:

- Identities, groups, roles and sessions
- Tenant configuration and keys
- Audit history
- Mailbox contents, when mail is implemented
- Backups and migration artefacts

No SaaS mailbox provider is the system of record. A relay may see a message in transit. It must not be the place users read mail.

## Tenant model

See ADR-0006. In short:

- `@aspec/orgs` runs in `multi` mode with the `shared` strategy. A tenant is an organisation.
- Accounts are global and join tenants through memberships. One account can belong to several tenants.
- Every authenticated API request is bound to one tenant the account is an active member of (`x-aspectenant-tenant` header from the admin UI, otherwise the oldest membership). Tenant routes take the tenant from that binding only.
- Tenant roles are assigned in organisation scope. `platform.operator` is global and grants no tenant permission. Its only reach into tenant data is `mailboxes:access`: operators can open any tenant's mailboxes, and every use is audited in that tenant (see ADR-0006).
- Every directory table carries `tenant_id` and has PostgreSQL row-level security. The request runs in a transaction that sets `app.tenant_id`; the API connects as the non-superuser `aspectenant_app` role so the policies apply.
- A verified domain belongs to one tenant. Mailbox addresses and aliases must use a verified domain of their tenant and are unique across the installation.

New tables that hold tenant data must carry `tenant_id`, be added to `TENANT_TABLES` in `apps/api/src/directory/schema.ts` so they get a row-level security policy, and be read through `DirectoryService` (or another service that takes the tenant from the request context).

## Authentication model

- Local accounts and cookie sessions: `@aspec/auth`
- Profile and lifecycle records: `@aspec/users`, keyed by the auth account id
- Authorisation: `@aspec/rbac`. `tenant.owner`, `tenant.admin` and `tenant.auditor` are assigned per tenant; `platform.operator` is assigned globally
- Public self-registration is disabled. The only bootstrap is `POST /api/v1/setup` while no users exist. Later accounts are created by tenant administrators or platform operators
- CSRF: state-changing requests must come from the panel's own host or the public URL saved in Settings
- WebAuthn, OIDC client (signing in with an external provider), SAML, SCIM and LDAP are present as library capabilities or future work. They are not exposed as product features

Service identities for SoftDock and other platforms will use `@aspec/api-keys` (vendored, not wired) and later OAuth client credentials. They must not share the human session cookie.

## Integration model

External platforms talk to ASPECTenant over stable HTTP APIs, service identities and later events/webhooks. They do not mount ASPECTenant tables or import this repository as a library.

See `docs/softdock-integration.md`.

## Mail

ASPECTenant is the mailbox platform. See `docs/mail-architecture.md`.

## Replaceable internals

| Concern | Current choice | Replacement rule |
|---------|----------------|------------------|
| HTTP | Hono 4 | Keep `@aspec/*` adapters or Fetch handlers |
| UI | React admin SPA | Do not copy Microsoft 365 chrome |
| Database | PostgreSQL 17 | SQL stores already have a SQLite dialect for tests |
| Auth protocols | `@aspec/auth` for accounts, sessions and TOTP; the OpenID-certified `oidc-provider` library for the OIDC provider | Embedded in the API process so it reuses accounts, sessions and tenants; no custom protocol code |
| Inbound mail transport | Contract only | Cloudflare Email Routing Worker or local MX |
| Outbound mail transport | Contract only | Cloudflare Email Sending, SMTP relay, SES, Postmark |
| Mailbox store | Directory records only | Message store must stay inside ASPECTenant, not in the transport |

## Directory map

```
apps/api          Control plane
apps/web          Administration UI
packages/aspec    Vendored ASPEC Dev Modules
docs              Architecture and ADRs
deploy/docker     Images
compose.yml       Local Docker stack
```
