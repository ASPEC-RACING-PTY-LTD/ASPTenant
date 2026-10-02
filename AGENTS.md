# Agent notes

Read `CONSTRAINTS.md` before writing code. Do not weaken it to make a change pass.

ASPECTenant is a self-hosted control plane for identity, administration and organisation-owned mailboxes. It is software created by ASPEC TECH, a business of ASPEC RACING PTY LTD. It is not SoftDock, Microsoft 365 or a document suite. Do not present ASPECTenant as the company name.

## Read first

- `docs/architecture.md`
- `docs/mail-architecture.md`
- `docs/softdock-integration.md`
- `docs/development.md`
- `docs/decisions/`

## Rules

- Prefer vendored `@aspec/*` packages in `packages/aspec` over new generic infrastructure.
- Do not modify `D:/SoftDock` or `D:/ASPEC Dev Modules`.
- Do not claim mail, IMAP, SMTP submission, OIDC provider, SAML, SCIM or SoftDock integration work unless you implemented and tested it.
- Cloudflare and other relays are transports. Mailbox data stays in ASPECTenant.
- Keep `.env.example` limited to values a developer actually needs.
