# Deployment

ASPECTenant is Docker-first and expects to sit behind an operator-provided reverse proxy. Cloudflare Tunnel is supported as that proxy. `cloudflared` is not included in this repository.

## Install from GitHub

On a host with Docker Engine and Compose:

```sh
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main/install.sh)"
```

The installer writes a three-line `.env` (`PUBLIC_URL`, `POSTGRES_PASSWORD`, `AUDIT_HMAC_KEY`), pulls `ghcr.io/aspec-racing-pty-ltd/aspectenant-api` and `aspectenant-web`, and starts Compose. Open `/setup` to create the super administrator.

GitHub Actions publishes those images from `main` and version tags.

## Local / single-host

`compose.yml` builds images locally. It is suitable for development and for a first private installation on loopback. Harden it before any public bind:

- Replace the Compose PostgreSQL password
- Set `PUBLIC_URL` to the HTTPS origin users will open
- Set `COOKIE_SECURE` implicitly by using `https://` in `PUBLIC_URL`
- Set `TRUSTED_PROXIES` to the proxy hop (often `private`) so `X-Forwarded-For` and `CF-Connecting-IP` are honoured
- Set `AUDIT_HMAC_KEY` to at least 32 characters
- Do not publish PostgreSQL or the API port on `0.0.0.0`

## Reverse proxy

Terminate TLS in Caddy, nginx, Traefik or Cloudflare Tunnel. Forward:

- `/` to the web container
- `/api`, `/auth`, `/livez`, `/readyz`, `/healthz` to the API (the bundled nginx image already does this)

Preserve `Host`, `X-Forwarded-Proto`, `X-Forwarded-For` and, on Cloudflare, `CF-Connecting-IP`.

## Backup

Today the only durable state is PostgreSQL. Back up that volume with ordinary `pg_dump` or volume snapshots. Mail data, object storage and key-management backups will be added when those stores exist.

## Health

- `GET /livez` process is up
- `GET /readyz` database is reachable
- `GET /healthz` same checks with more detail

Do not expose `/healthz` publicly with full detail on an untrusted network.
