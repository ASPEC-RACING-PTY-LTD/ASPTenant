import { describe, expect, it } from 'vitest';
import { createRbac, defineRbac } from '../src/index.js';
import { createMemoryStore } from '../src/memory.js';

describe('cache invalidation', () => {
  it('drops cached assignments after revoke', async () => {
    const cache = new Map<string, unknown>();
    const rbac = createRbac({
      store: createMemoryStore(),
      definition: defineRbac({
        permissions: ['posts:read'],
        roles: [{ key: 'viewer', permissions: ['posts:read'] }],
      }),
      preventEscalation: false,
      cache: {
        async get<T>(key: string) {
          return cache.get(key) as T | undefined;
        },
        async set(key, value) {
          cache.set(key, value);
        },
        async delete(key) {
          cache.delete(key);
        },
      },
    });
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'viewer' });
    expect(await rbac.can({ id: 'u1' }, 'posts:read')).toBe(true);
    expect(cache.size).toBeGreaterThan(0);
    await rbac.admin.revokeRole({ subjectId: 'u1', roleKey: 'viewer' });
    expect(await rbac.can({ id: 'u1' }, 'posts:read')).toBe(false);
  });
});
