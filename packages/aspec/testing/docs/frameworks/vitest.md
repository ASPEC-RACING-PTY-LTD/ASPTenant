# Vitest

```ts
import { defineAspecVitestConfig, useFakeTimers, cleanupAll } from '@aspec/testing';
import { afterEach, vi } from 'vitest';

export default defineAspecVitestConfig({
  setupFiles: ['test/setup.ts'],
  coverage: { thresholds: { lines: 80, branches: 75 } },
});

afterEach(async () => {
  await cleanupAll();
});

it('advances fake timers', () => {
  using timers = useFakeTimers(vi);
  let done = false;
  setTimeout(() => {
    done = true;
  }, 100);
  timers.advance(100);
  expect(done).toBe(true);
});
```

Tested with Vitest 5.0.2.
