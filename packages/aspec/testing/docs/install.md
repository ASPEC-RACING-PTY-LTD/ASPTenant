# Install

## CLI (package mode)

```bash
aspec add aspec/testing
```

## Manual npm / pnpm / yarn

```bash
pnpm add -D @aspec/testing vitest
```

Optional peers (install only what you use):

| Peer | When |
|------|------|
| `vitest` | Scaffolded configs, `useFakeTimers(vi)` |
| `express` | Express apps under test (types only for templates) |
| `fastify` | Fastify inject clients |
| `hono` | Hono `app.request` clients |
| `pg` | PostgreSQL fixtures (`createPostgresClient`) |

## Vendor mode

Copy `src/` (or `dist/`) into your project and point imports at the vendored path. The integration templates use `imports.*` so vendor mode resolves correctly.

## Scaffold

```bash
pnpm exec aspec-testing init
pnpm exec aspec-testing generate unit users
pnpm exec aspec-testing generate api orders --dry-run --json
```

Never overwrites existing files; conflicts are reported and the process exits non-zero unless `--dry-run`.
