# Vitest

```ts
import { defineConfig, env } from '@aspec/config';

const config = defineConfig(
  { port: env.port('PORT').default(3000) },
  { ignoreFiles: true, processEnv: { PORT: '4000' } },
);
```

Pass `ignoreFiles: true` and an explicit `processEnv` for hermetic tests.
