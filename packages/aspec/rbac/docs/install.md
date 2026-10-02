# Install

## Package

```bash
pnpm add @aspec/rbac
# or: npm install @aspec/rbac / yarn add @aspec/rbac
```

## Peer dependencies (optional adapters)

| Adapter | Package | Range |
|---------|---------|-------|
| Express | `express` | `^4.18.0 \|\| ^5.0.0` |
| Fastify | `fastify` | `^5.0.0` |
| Hono | `hono` | `^4.0.0` |
| React | `react` | `^19.0.0` |

SQL stores need a `SqlClient` (from `@aspec/db` or a short adapter around `pg` / Node's `node:sqlite`).

## CLI

```bash
aspec add aspec/rbac
aspec integrate aspec/rbac --target express-typescript
```

## Vendor mode

Copy `src/` (or `dist/`) into your application when installing with `--mode vendor`.
