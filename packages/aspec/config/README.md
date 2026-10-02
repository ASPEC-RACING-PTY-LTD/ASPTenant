# @aspec/config

Typed application configuration and secrets for Node.js.

Define a schema with `env.port`, `env.url(...).secret()`, nested groups and more.
`defineConfig` loads dotenv files, validates every variable, and returns a frozen
deep-typed object. Secrets never appear in logs, JSON or generated docs.

## Install

```bash
aspec add aspec/config
# or
pnpm add @aspec/config
```

## Quick start

```ts
import { defineConfig, env } from '@aspec/config';

export const config = defineConfig({
  port: env.port('PORT').default(3000),
  databaseUrl: env.url('DATABASE_URL').secret(),
  logLevel: env.enum('LOG_LEVEL', ['debug', 'info', 'warn', 'error']).default('info'),
  allowedOrigins: env.list('ALLOWED_ORIGINS').default([]),
  features: {
    signup: env.boolean('FEATURE_SIGNUP').default(true),
  },
});
```

## Docs

- [Summary](docs/summary.md) · [Configure](docs/configure.md) · [API](docs/api.md) · [AI](docs/ai.md)

## Licence

MIT
