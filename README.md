# ASPECTenant

Self-hosted control plane for organisation identity, administration and organisation-owned mailboxes. Created by ASPEC TECH, a business of ASPEC RACING PTY LTD.

## Install

On a host with Docker Engine and the Compose plugin:

```sh
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main/install.sh)"
```

- Installs into `aspectenant/` under the directory you run it from (for example `/root/aspectenant`). The panel binds to `127.0.0.1` on the first free port from 8080; the installer prints it for your `cloudflared` tunnel.
- Menu: 1) Install (asks for the public URL; replaces any existing installation), 2) Upgrade / repair (keeps data), 3) Uninstall.
- Nothing to configure: `.env` only holds generated secrets.
- The installer prints a one-time **setup code**. Open `/setup`, enter it and create the super administrator (or restore a backup). Then set your **Public URL** under Settings. Everything else (domains, mailboxes, Cloudflare, SMTP, mail apps, backups, updates) is managed in the panel.
- Re-running the installer and choosing 2 upgrades in place and keeps data.

Mail apps (Outlook, Apple Mail, phones) use IMAP 993 and SMTP 465/587 directly; enable them on **Mail apps** and forward those ports. Import Microsoft 365 PST exports on **Migration**. Configure encrypted R2/S3 backups on **Backups**.

Then follow **Mail settings** in the panel to connect Cloudflare Email Routing (inbound) and Cloudflare Email Sending or any SMTP relay (outbound).

Updates: the **Updates** page checks GitHub releases and installs them through the bundled updater container. Automatic updates can be switched off there.

Releases are published by pushing a `vX.Y.Z` tag. Images:

- `ghcr.io/aspec-racing-pty-ltd/aspectenant-api`
- `ghcr.io/aspec-racing-pty-ltd/aspectenant-web`

## Local development

```sh
docker compose up --build
```

Open http://localhost:8080/setup and use the setup code from `docker compose logs api`. Host-side development is documented in [docs/development.md](docs/development.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Mail](docs/mail-architecture.md)
- [SoftDock boundary](docs/softdock-integration.md)
- [Development](docs/development.md)
- [Deployment](docs/deployment.md)
- [Decisions](docs/decisions/)
- [ASPEC Dev Modules reuse](docs/aspec-modules.md)

## Licence

MIT. Vendored packages under `packages/aspec` keep their own MIT licences.
