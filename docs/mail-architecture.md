# Mail architecture

ASPECTenant provides and owns the mailbox platform. Email is not "forward everything to Gmail or Microsoft 365". A successful deployment can move business mail off Exchange Online and keep the mailboxes here.

## What works today

- Mailboxes (user and shared), aliases, delegates and distribution groups with an address. Addresses must be on a domain registered under Domains.
- Message store in PostgreSQL: raw MIME plus indexed metadata, folders Inbox, Sent, Archive, Junk, Trash.
- Inbound: `POST /api/v1/mail/ingest` with a bearer ingest token. The Worker in `deploy/cloudflare/email-worker.js` (also shown with your URL on Mail settings) forwards each Cloudflare Email Routing delivery. Unknown recipients get a 550 reject. Duplicate Message-IDs per mailbox are dropped.
- Outbound: Cloudflare Email Sending over SMTP (`smtp.mx.cloudflare.net:465`, user `api_token`) or any SMTP server/relay, configured and tested live on Mail settings. Credentials are AES-256-GCM encrypted in the database. Mail to local recipients is delivered internally and never leaves the server.
- Webmail at `/mailbox`: read (HTML in a sandboxed frame with remote scripts blocked), search, reply, reply all, forward, attachments, move, delete, download `.eml`.
- Domains page: TXT ownership verification and MX, SPF and DMARC checks.

- Mail apps: IMAPS 993 and SMTP submission 465/587 (`apps/api/src/imap`, `apps/api/src/mailserver`). Login is the ASPECTenant email and password. Shared and delegated mailboxes appear under `Shared/<address>/`. Submitted mail goes through the same outbound transport; clients save their own copy to Sent. Certificates come from Let's Encrypt (Cloudflare DNS-01 token) or an uploaded PEM and renew automatically. These ports bypass Cloudflare Tunnel: forward them to the host and use a DNS-only record.
- PST import (Migration page): chunked resumable upload, folders mapped (Inbox, Sent Items, Deleted Items, Junk, Drafts, custom), read state and dates kept. A content key per message makes re-imports skip duplicates.

Not implemented yet: spam scoring (Cloudflare Email Routing applies its own checks before the Worker), retention policies, quota enforcement, full-text index, IMAP keywords and CONDSTORE.

The rest of this document describes the design those pieces follow.

## Ownership

| Layer | Owner | Examples |
|-------|-------|----------|
| Mailbox data | ASPECTenant | Users, shared mailboxes, folders, messages, attachments, aliases, distribution lists, quotas, retention, search, spam/quarantine, Sent/Drafts/Trash, delegation |
| Administration | ASPECTenant | Provisioning, tracing, policies, migration |
| Access | ASPECTenant | IMAP, later JMAP if useful, self-hosted webmail |
| Transport | Replaceable provider | Cloudflare Email Routing / Email Sending, direct SMTP, generic relay, SES, Postmark |

A transport may add, remove or hold a message for delivery. It is not the inbox.

## Target flows

### Inbound

1. Public MX for the organisation domain points at the configured inbound transport.
2. Preferred path when the domain is on Cloudflare: Email Routing delivers to a Worker `email()` handler.
3. The Worker buffers `message.raw` once, then POSTs the MIME and envelope to ASPECTenant ingest (authenticated service identity).
4. ASPECTenant accepts or rejects, stores the message in the destination mailbox, and updates indexes and quarantine state.
5. Users read the message from ASPECTenant over IMAP or webmail.

Alternative inbound path: a self-hosted MTA (or another provider) performs the same ingest POST, or writes through a local SMTP injection interface later. The mailbox store does not change.

### Outbound

1. A user sends from webmail or SMTP/IMAP submission into ASPECTenant.
2. The message is stored in Sent (or Drafts) first.
3. ASPECTenant submits through the configured outbound transport.
4. Preferred path when the operator does not want to run a public MTA: Cloudflare Email Sending over SMTP (`smtp.mx.cloudflare.net:465`) or REST.
5. Direct SMTP or a generic relay remain first-class options.

## Transport catalogue

The TypeScript catalogue lives in `apps/api/src/mail/contracts.ts` and is exposed (read-only) at `GET /api/v1/platform`.

### Cloudflare Email Routing (inbound)

Verified against [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) and [limits](https://developers.cloudflare.com/email-service/platform/limits/) on 2026-10-02.

Use it:

- Domain is already on Cloudflare
- You want Cloudflare to terminate public MX and hand ASPECTenant the raw message

Do not use it as:

- A mailbox
- IMAP
- Long-term storage (Durable Object / R2 examples in Cloudflare docs are Cloudflare-hosted storage, not ASPECTenant)

Constraints that matter:

- Routing is MX plus rules or a Worker. Cloudflare does not keep an organisation inbox.
- The Worker must consume, forward or reject the message. Returning without doing so drops the mail.
- Inbound size: 25 MiB
- 200 routing rules per domain: create a catch-all (or domain) Worker, not one rule per mailbox
- 200 verified destination addresses per Cloudflare account: those are forward targets, not ASPECTenant mailboxes
- `message.raw` is a single-use stream
- Workers Free plan CPU limits can fail complex handlers

ASPECTenant must not bundle `cloudflared`. Operators who already use Cloudflare Tunnel for HTTP can keep doing that independently of MX.

### Cloudflare Email Sending (outbound)

Verified against the same docs plus [SMTP submission](https://developers.cloudflare.com/email-service/api/send-emails/smtp/) on 2026-10-02.

Use it to avoid running a public outbound MTA and to inherit Cloudflare's DKIM/SPF onboarding.

Constraints that matter:

- It is transactional, not a marketing ESP. Workers Paid includes 3,000 messages a month, then $0.35 per 1,000 (pricing page, 2026-10-02)
- Sending to arbitrary recipients requires the Workers Paid plan. Sends only to verified destination addresses are available more broadly and are the wrong model for a mailbox platform
- SMTP: `smtp.mx.cloudflare.net:465`, implicit TLS, username `api_token`, password a Cloudflare API token with Email Sending: Edit
- No outbound port 587 STARTTLS. No unauthenticated port 25 outbound. Port 25 is inbound Email Routing
- Outbound SIZE 5 MiB (25 MiB only to verified destinations). Business mail with attachments will need another outbound transport when over 5 MiB
- At most 50 recipients per message
- Daily quotas start conservative and are reputation-based
- Suppression lists can accept a recipient at `RCPT TO` and later drop it

These limits are why Cloudflare is a preferred transport, not the only one, and not a reason to store mail in Cloudflare.

### Direct SMTP and generic relay

Always supported in the model. Required when:

- The operator is not on Cloudflare
- Messages exceed Cloudflare's outbound size
- The operator already has a reputable smarthost
- Policy forbids a third-party sending API

### SES / Postmark

Reserved outbound kinds. Same mailbox-ownership rules. Not implemented.

## Mailbox platform (future implementation)

The store should be replaceable behind ASPECTenant APIs, but the default must be local:

- Metadata in PostgreSQL
- Message bodies and attachments on local volumes or operator-owned object storage
- Search/index as a dedicated component later
- IMAP (and possibly JMAP) in front of that store
- Webmail as an ASPECTenant application that uses the same store, not an iframe to Outlook or Gmail

Do not adopt a hosted mailbox (Exchange Online, Google Workspace, Fastmail, Cloudflare Durable Object inbox) as the system of record.

Mature open-source mail servers (for example Stalwart) may be used underneath if they remain swappable and ASPECTenant remains the administrative plane. That decision is not made in this scaffold.

## Not done here

- Configure Cloudflare automatically (the Worker and routing rule are set up by hand, guided on Mail settings)
- Bundle cloudflared
