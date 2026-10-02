import { describe, expect, it } from 'vitest';
import {
  createRbac,
  defineRbac,
  RbacEscalationError,
  RbacImmutableError,
  RbacInUseError,
} from '../src/index.js';
import { createMemoryStore } from '../src/memory.js';

describe('admin API', () => {
  it('blocks system role mutation and in-use deletes', async () => {
    const rbac = createRbac({
      store: createMemoryStore(),
      definition: defineRbac({
        permissions: ['posts:read'],
        roles: [{ key: 'viewer', permissions: ['posts:read'] }],
      }),
      preventEscalation: false,
    });
    await expect(rbac.admin.updateRole('viewer', { name: 'X' })).rejects.toBeInstanceOf(
      RbacImmutableError,
    );
    await rbac.admin.createRole({ key: 'temp', permissions: ['posts:read'] });
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'temp' });
    await expect(rbac.admin.deleteRole('temp')).rejects.toBeInstanceOf(RbacInUseError);
    await rbac.admin.deleteRole('temp', { force: true });
    expect(await rbac.admin.listRoles().then((r) => r.some((x) => x.key === 'temp'))).toBe(false);
  });

  it('prevents privilege escalation', async () => {
    const rbac = createRbac({
      store: createMemoryStore(),
      definition: defineRbac({
        permissions: ['posts:read', 'posts:write', 'posts:delete'],
        roles: [
          { key: 'reader', permissions: ['posts:read'] },
          {
            key: 'super',
            permissions: ['rbac:admin', 'posts:read', 'posts:write', 'posts:delete'],
          },
        ],
      }),
      preventEscalation: true,
    });
    await rbac.admin.assignRole({ subjectId: 'mgr', roleKey: 'reader' });
    await expect(
      rbac.admin.createRole(
        { key: 'elevated', permissions: ['posts:delete'] },
        { actor: { id: 'mgr' } },
      ),
    ).rejects.toBeInstanceOf(RbacEscalationError);

    await rbac.admin.assignRole({ subjectId: 'boss', roleKey: 'super' });
    await expect(
      rbac.admin.createRole(
        { key: 'elevated', permissions: ['posts:delete'] },
        { actor: { id: 'boss' } },
      ),
    ).resolves.toMatchObject({ key: 'elevated' });
  });

  it('records audit before/after for role updates', async () => {
    const events: { action: string; changes?: { before?: unknown; after?: unknown } }[] = [];
    const rbac = createRbac({
      store: createMemoryStore(),
      definition: defineRbac({
        permissions: ['posts:read', 'posts:write'],
        roles: [],
      }),
      preventEscalation: false,
      audit: {
        async record(event) {
          const entry: { action: string; changes?: { before?: unknown; after?: unknown } } = {
            action: event.action,
          };
          if (event.changes !== undefined) entry.changes = event.changes;
          events.push(entry);
        },
      },
    });
    await rbac.admin.createRole({ key: 'r1', permissions: ['posts:read'] });
    await rbac.admin.updateRole('r1', { permissions: ['posts:read', 'posts:write'] });
    const updated = events.find((e) => e.action === 'rbac.role.updated');
    expect(updated?.changes?.before).toBeTruthy();
    expect(updated?.changes?.after).toBeTruthy();
  });
});
