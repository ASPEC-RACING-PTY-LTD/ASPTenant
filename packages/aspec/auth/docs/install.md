# Install

## ASPEC CLI

```bash
aspec install aspec/auth
```

Choose package mode (npm dependency) or vendor mode (copies source into your project).

## npm / pnpm / yarn

```bash
pnpm add @aspec/auth
```

Runtime dependency: `jose`. Optional peers:

| Adapter / feature | Peer |
|-------------------|------|
| `@aspec/auth/express` | `express` `^4.18.0 \|\| ^5.0.0` |
| `@aspec/auth/fastify` | `fastify` `^5.0.0` |
| `@aspec/auth/hono` | `hono` `^4.0.0` |
| `@aspec/auth/webauthn` | `@simplewebauthn/server` `^13.0.0 \|\| ^14.0.0` |
| SQL store with `pg` | `pg` (application-provided `SqlClient`) |

Node.js `>=22.13.0` is required.
