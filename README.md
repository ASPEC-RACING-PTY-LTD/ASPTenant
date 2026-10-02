# ASPECTenant

Self-hosted control plane for organisation identity, administration and organisation-owned mailboxes. Created by ASPEC TECH, a business of ASPEC RACING PTY LTD.

## Install

On a host with Docker Engine and the Compose plugin:

```sh
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main/install.sh)"
```

Unattended:

```sh
sudo env PUBLIC_URL=https://tenant.example.com bash -c "$(curl -fsSL https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main/install.sh)"
```

Open `/setup` and create the super administrator. `.env` only needs the public URL and generated store credentials. Everything else is collected on that first-run page.

Published images:

- `ghcr.io/aspec-racing-pty-ltd/aspectenant-api`
- `ghcr.io/aspec-racing-pty-ltd/aspectenant-web`

## Local development

```sh
cp .env.example .env
docker compose up --build
```

Open http://localhost:8080/setup. Host-side development is documented in [docs/development.md](docs/development.md).

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
