# Integrate

```ts
import { defineConfig, env, redactConfig } from '@aspec/config';

export const config = defineConfig({
  port: env.port('PORT').default(3000).description('HTTP listen port'),
  databaseUrl: env.url('DATABASE_URL', { protocols: ['postgres', 'postgresql'] }).secret(),
  logLevel: env.enum('LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const).default('info'),
  allowedOrigins: env.list('ALLOWED_ORIGINS').default([]),
  features: {
    signup: env.boolean('FEATURE_SIGNUP').default(true),
  },
});

console.log(redactConfig(config)); // never prints the database URL
```

## External secrets

```ts
import { loadConfig, env } from '@aspec/config';
import { createVaultKvV2Provider } from '@aspec/config/vault';

const vault = createVaultKvV2Provider({
  address: process.env.VAULT_ADDR!,
  token: process.env.VAULT_TOKEN,
});

export const config = await loadConfig({
  shape: {
    databaseUrl: env.url('DATABASE_URL').secret(),
  },
  secrets: {
    DATABASE_URL: { provider: vault, id: 'app/db#url' },
  },
});
```

Vault was tested against an in-process KV v2 mock only (`tested: false` for the live service).
