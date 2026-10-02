# Install

## CLI

```bash
aspec add aspec/audit
```

## npm

```bash
pnpm add @aspec/audit
```

## Peer dependencies per adapter

| Adapter | Package | Range |
|---------|---------|-------|
| Express | `express` | `^4.18.0 \|\| ^5.0.0` |
| Fastify | `fastify` | `^5.0.0` |
| Hono | `hono` | `^4.0.0` |
| Fetch | (none) | Web Fetch API |
| SQL | a `SqlClient` (for example `@aspec/db` or a five-line `pg` wrapper) | |

The core entrypoint has no required peers. Install only the adapters you use.
