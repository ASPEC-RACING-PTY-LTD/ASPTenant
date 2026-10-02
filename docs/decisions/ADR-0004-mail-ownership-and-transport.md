# ADR-0004: ASPECTenant owns mailboxes; relays are transports

## Status
Accepted

## Date
2026-10-02

## Context
The product must let an organisation leave Microsoft 365 / Exchange Online. Cloudflare Email Service can terminate MX and submit outbound mail, but official docs (retrieved 2026-10-02) show it is routing and transactional sending, not a mailbox. Inbound size 25 MiB, 200 rules per domain, outbound SMTP only on port 465, outbound SIZE 5 MiB to arbitrary recipients, transactional Beta product.

## Decision
- Mailbox data, IMAP and webmail belong to ASPECTenant.
- Inbound and outbound providers implement a transport interface.
- Cloudflare Email Routing (Worker to ingest) and Email Sending (SMTP/REST) are preferred transports, never exclusive ones.
- Direct SMTP and generic relays stay in the catalogue.
- This scaffold ships contracts only.

## Alternatives considered

### Forward to Gmail / Microsoft 365
Fails the migration goal.

### Store mail in Cloudflare Durable Objects / R2 as the system of record
Couples mailbox data to a vendor and contradicts self-hosted ownership.

### Bundle an MTA and cloudflared now
Unnecessary for the scaffold and would hide the transport boundary.

## Consequences
Later mail work starts from `apps/api/src/mail/contracts.ts` and `docs/mail-architecture.md`. A 5 MiB Cloudflare outbound limit means large attachments need another outbound transport or a different submission path.
