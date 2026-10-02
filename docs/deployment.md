# Deployment

ASPECTenant is Docker-first and expects to sit behind an operator-provided reverse proxy. Cloudflare Tunnel is supported as that proxy. `cloudflared` is not included in this repository.

## Install from GitHub

```sh
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main/install.sh)"
```

The installer writes `./aspectenant/compose.yml` (relative to where it runs) and a `.env` of generated values only (`POSTGRES_PASSWORD`, `AUDIT_HMAC_KEY`, `INSTALL_DIR`). The public URL is set on the Settings page, pulls the images, starts Compose and prints the one-time setup code. Re-running it upgrades and keeps data.

The panel binds to `127.0.0.1:8080`. With cloudflared on the same host, add a public hostname that points at `http://localhost:8080`. Set `ASPECTENANT_BIND=0.0.0.0` before installing only if the proxy runs elsewhere.

If Cloudflare Access protects the hostname, bypass `/api/v1/mail/ingest` so the Email Routing Worker can deliver.

## Mail apps and data

- The API container publishes 993 (IMAPS), 465 (SMTPS) and 587 (submission) on all interfaces. Forward them on your router to the host and point a DNS-only (grey cloud) A record at your public IP. Set `ASPECTENANT_MAIL_BIND` to restrict.
- `/data` (volume `data`) holds PST uploads and backup staging. A certificate can also be supplied as `/data/mail-tls/fullchain.pem` and `/data/mail-tls/privkey.pem`; the panel's certificate takes precedence.
- Listener state: Mail apps shows each listener (IMAPS 1993, SMTPS 1465, submission 1587 inside the container) with a live connection test, and `/healthz` reports `mailApps`. When they cannot start, the API logs `mail_apps_start_failed` or `mail_apps_listener_failed` with the reason (no certificate, key cannot be decrypted, certificate and key mismatch, port in use). Failed listeners are retried every minute.

## Backups

Configure on the Backups page: R2 or any S3 bucket, an encryption passphrase, schedule and retention. Each backup is a gzip of every table (including all messages), encrypted with AES-256-GCM using a key derived from the passphrase. It also carries the settings key, so stored credentials keep working after restoring onto a new server. Disaster recovery: install fresh, open `/setup`, choose Restore from backup.

## Releases and updates

- Push a tag such as `v0.2.0`. CI runs the checks, publishes `:0.2.0`, `:0.2` and `:latest`, then creates the GitHub release.
- Pushes to `main` publish `:edge` only.
- GHCR packages are private on first publish. Make both packages public (Package settings, Change visibility) so servers can pull without logging in.
- The Updates page checks the latest GitHub release. Update writes a request to a shared volume; the `updater` container (Docker CLI with the Docker socket, no network) runs `docker compose pull api web` and `docker compose up -d api web`. Automatic updates run every 6 hours unless switched off. Remove the `updater` service to disable in-app updates.
- Changes to `compose.yml` itself are applied by re-running the installer.

## Local / single-host

`compose.yml` builds images locally. It is suitable for development and for a first private installation on loopback. Harden it before any public bind:

- Replace the Compose PostgreSQL password
- Set the public URL (Settings page) to the HTTPS origin users open; an https URL makes session cookies Secure
- Set `TRUSTED_PROXIES` to the proxy hop (often `private`) so `X-Forwarded-For` and `CF-Connecting-IP` are honoured
- Set `AUDIT_HMAC_KEY` to at least 32 characters
- Do not publish PostgreSQL or the API port on `0.0.0.0`

## Reverse proxy

Terminate TLS in Caddy, nginx, Traefik or Cloudflare Tunnel. Forward:

- `/` to the web container
- `/api`, `/auth`, `/livez`, `/readyz`, `/healthz` to the API (the bundled nginx image already does this)

Preserve `Host`, `X-Forwarded-Proto`, `X-Forwarded-For` and, on Cloudflare, `CF-Connecting-IP`.

## Backup

All durable state, including every mail message, is in PostgreSQL. Back it up with `docker compose exec postgres pg_dump -U aspec aspec > backup.sql` or volume snapshots. Keep `.env` too: `AUDIT_HMAC_KEY` also encrypts the stored SMTP and Cloudflare credentials.

## Health

- `GET /livez` process is up
- `GET /readyz` database is reachable
- `GET /healthz` same checks with more detail (API container only, not routed by the web container)

## Domain Connect

Verify on the Domains page uses [Domain Connect](https://www.domainconnect.org): it finds the domain's DNS provider from `_domainconnect.<domain>`, opens a signed apply URL in a pop-up, and the provider adds the verification, MX, SPF and DMARC records from `deploy/domainconnect/aspecracing.com.au.aspectenant-mail.json`. ASPECTenant then confirms the TXT record in public DNS before marking the domain verified. If the provider does not support Domain Connect or has not onboarded the template, the manual records are shown instead.

Onboarding (once, by ASPEC TECH): generate the key pair under Settings > Domain Connect, publish the shown TXT record at `<keyId>.<providerId>`, submit the template to github.com/Domain-Connect/Templates, then email domain-connect@cloudflare.com with the template link, the key domain and a logo. The Cloudflare API connection remains for mail apps certificates and Email Routing.
