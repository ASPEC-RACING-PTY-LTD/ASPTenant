# ASPECTenant architecture

ASPECTenant is an open-source, self-hosted control plane for a single organisation today, with a data model that can isolate multiple tenants later. It administers identities, access, domains, applications and mail. It does not replace Word, Excel, PowerPoint, OneDrive, SharePoint, Teams, Intune or SoftDock.

## What exists now

The control plane is a working administrative foundation:

- Docker Compose: PostgreSQL, control-plane API, admin UI
- First-time setup of one organisation owner
- Email/password sessions, session revoke and password change
- Seeded RBAC (`tenant.owner`, `tenant.admin`, `tenant.auditor`)
- User directory (create, profile, suspend/reinstate)
- Security and distribution groups with membership
- Custom domains with DNS TXT verification and MX/SPF/DMARC checks
- Mailboxes with stored messages, aliases, delegates and distribution groups
- Inbound mail through Cloudflare Email Routing (Worker to ingest API) and outbound through Cloudflare Email Sending or SMTP
- Built-in webmail and live mail settings in the panel
- In-app updates through an updater sidecar
- Application registration records (no OIDC/SAML IdP)
- Organisation settings
- Searchable audit history
- Health, readiness and system diagnostics

IMAP, MFA UI, SAML, SCIM, LDAP, mailbox migration and SoftDock integration are specified, not shipped.

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

`@aspec/orgs` runs in `single` mode. Setup creates the implicit default organisation (`id=default`) and adds the first user as owner.

The store already supports multi-organisation records, memberships, teams and optional tenant provisioning strategies (`schema` / `database` / application-level). Do not assume a shared global user table will remain acceptable. New domain tables should carry `tenant_id` (the organisation id) from the start.

## Authentication model

- Local accounts and cookie sessions: `@aspec/auth`
- Profile and lifecycle records: `@aspec/users`, keyed by the auth account id
- Authorisation: `@aspec/rbac` with seeded `tenant.owner`, `tenant.admin` and `tenant.auditor`
- Public self-registration is disabled. The only bootstrap is `POST /api/v1/setup` while no users exist
- CSRF: state-changing requests must come from the panel's own host or the public URL saved in Settings
- MFA, WebAuthn, OIDC client, SAML, SCIM and LDAP are present as library capabilities or future work. They are not exposed as working product features in this scaffold

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
| Auth protocols | `@aspec/auth` plus later standard IdP software | Prefer Ory Hydra / similar over a custom OIDC provider |
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
