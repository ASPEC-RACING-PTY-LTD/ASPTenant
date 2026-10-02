import { describe, expect, it } from 'vitest';
import { createRbac, defineRbac } from '../src/index.js';
import { createMemoryStore } from '../src/memory.js';

describe('performance', () => {
  it('evaluates 10000 checks within a loose budget', async () => {
    const rbac = createRbac({
      store: createMemoryStore(),
      definition: defineRbac({
        permissions: ['posts:read', 'posts:write', 'posts:delete', 'comments:read'],
        roles: [
          { key: 'viewer', permissions: ['posts:read', 'comments:read'] },
          { key: 'editor', permissions: ['posts:write'], parents: ['viewer'] },
          { key: 'admin', permissions: ['posts:delete'], parents: ['editor'] },
        ],
      }),
      preventEscalation: false,
    });
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'admin' });
    const subject = { id: 'u1' };
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      await rbac.can(subject, i % 2 === 0 ? 'posts:read' : 'posts:write');
    }
    const elapsed = performance.now() - start;
    // Loose threshold: 10k checks should finish well under 10s on this machine.
    expect(elapsed).toBeLessThan(10_000);
  });
});
