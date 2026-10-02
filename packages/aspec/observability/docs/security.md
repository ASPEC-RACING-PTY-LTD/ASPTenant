# Security

## Threat model

- Logs and health details can leak secrets or internals.
- `/metrics` can expose business volume; protect on public networks.
- Request ID and trace headers can be forged; only trust incoming IDs when appropriate.

## Secure defaults

- Password/token keys are redacted.
- Health detail defaults to `basic`; use `detailToken` for full detail.
- Optional `metricsToken` gates `/metrics`.
- Tokens compared with SHA-256 digests in constant time.

## Operations

- Prefer `ignorePaths` for probes so they do not inflate HTTP metrics.
- Do not put secrets in metric labels.