# Vitest

Inject a clock and ID generator for deterministic tests. Use the memory store.

```ts
import { describe, expect, it } from 'vitest';
import { createAuditLogger, createMemoryAuditStore } from '@aspec/audit';

describe('billing', () => {
  it('audits refunds', async () => {
    let t = 1_700_000_000_000;
    const store = createMemoryAuditStore();
    const audit = createAuditLogger({
      sink: store,
      clock: { now: () => t++ },
      generateId: (() => {
        let n = 0;
        return () => `evt-${++n}`;
      })(),
    });
    await audit.record({
      action: 'billing.refund.create',
      actor: { id: 'admin_1' },
      resource: { type: 'refund', id: 'r1' },
      category: 'admin',
    });
    expect(store.all()[0]?.id).toBe('evt-1');
    expect((await audit.verifyChain('admin')).ok).toBe(true);
  });
});
```
