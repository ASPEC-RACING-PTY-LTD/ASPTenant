# Integrate

## 1. Install as a dev dependency

```bash
pnpm add -D @aspec/testing vitest
```

## 2. Add Vitest setup

```ts
// vitest.config.ts
import { defineAspecVitestConfig } from '@aspec/testing';

export default defineAspecVitestConfig({
  setupFiles: ['test/setup.ts'],
});
```

```ts
// test/setup.ts
import { afterEach } from 'vitest';
import { cleanupAll, resetSequences, setSeed } from '@aspec/testing';

setSeed(process.env.ASPEC_TEST_SEED ?? 'aspec-testing');

afterEach(async () => {
  resetSequences();
  await cleanupAll();
});
```

## 3. Write tests

```ts
import { createTestClient, defineFactory, createSqliteClient, migrate } from '@aspec/testing';

const users = defineFactory((ctx) => ({
  id: ctx.random.uuid(),
  email: ctx.random.email(),
}), { name: 'user' });

it('serves health', async () => {
  const client = createTestClient(app);
  await client.get('/health').expect(200).expectJson({ ok: true });
});
```

## 4. Optional: scaffold

```bash
pnpm exec aspec-testing init
```

Works with Vitest and with `node:test` (import the built package from a `.mjs` test file).
