import { describe, expect, it } from 'vitest';
import {
  createRbac,
  defineRbac,
  RbacCycleDetectedError,
  RbacForbiddenError,
} from '../src/index.js';
import { createMemoryStore } from '../src/memory.js';
import { createSnapshotEvaluator } from '../src/snapshot.js';

const definition = defineRbac({
  permissions: [
    'posts:read',
    'posts:write',
    'posts:delete',
    'comments:read',
    'comments:write',
    'billing:manage',
  ],
  roles: [
    {
      key: 'viewer',
      permissions: ['posts:read', 'comments:read'],
    },
    {
      key: 'editor',
      permissions: ['posts:write', 'comments:write'],
      parents: ['viewer'],
    },
    {
      key: 'admin',
      permissions: ['posts:delete', 'billing:manage'],
      parents: ['editor'],
      denies: ['billing:manage'],
    },
    {
      key: 'org-admin',
      permissions: ['posts:*'],
      assignableScopes: ['org', 'team'],
    },
  ],
  ownership: [{ resourceType: 'posts', permissions: ['posts:write', 'posts:delete'] }],
  policies: [
    {
      id: 'deny-other-org',
      effect: 'deny',
      permissions: ['posts:*'],
      condition: {
        all: [
          { attr: 'resource.orgId', op: 'exists' },
          { attr: 'subject.orgId', op: 'exists' },
          { attr: 'resource.orgId', op: 'neq', value: { ref: 'subject.orgId' } },
        ],
      },
    },
  ],
});

describe('createRbac evaluation', () => {
  it('covers wildcards and hierarchy with multiple inheritance', async () => {
    const rbac = createRbac({
      store: createMemoryStore(),
      definition,
      preventEscalation: false,
    });
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'editor' });
    expect(await rbac.can({ id: 'u1' }, 'posts:read')).toBe(true);
    expect(await rbac.can({ id: 'u1' }, 'posts:write')).toBe(true);
    expect(await rbac.can({ id: 'u1' }, 'posts:delete')).toBe(false);
    expect(await rbac.can({ id: 'u1' }, 'posts:*')).toBe(false);

    await rbac.admin.createRole({
      key: 'hybrid',
      permissions: ['billing:manage'],
      parents: ['viewer', 'editor'],
    });
    await rbac.admin.assignRole({ subjectId: 'u2', roleKey: 'hybrid' });
    expect(await rbac.can({ id: 'u2' }, 'posts:read')).toBe(true);
    expect(await rbac.can({ id: 'u2' }, 'posts:write')).toBe(true);
    expect(await rbac.can({ id: 'u2' }, 'billing:manage')).toBe(true);
  });

  it('rejects hierarchy cycles', async () => {
    const rbac = createRbac({ store: createMemoryStore(), definition, preventEscalation: false });
    await rbac.admin.createRole({ key: 'a', permissions: ['posts:read'] });
    await rbac.admin.createRole({ key: 'b', permissions: ['posts:write'], parents: ['a'] });
    await expect(rbac.admin.updateRole('a', { parents: ['b'] })).rejects.toBeInstanceOf(
      RbacCycleDetectedError,
    );
  });

  it('applies deny precedence over allows', async () => {
    const rbac = createRbac({ store: createMemoryStore(), definition, preventEscalation: false });
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'admin' });
    expect(await rbac.can({ id: 'u1' }, 'posts:delete')).toBe(true);
    expect(await rbac.can({ id: 'u1' }, 'billing:manage')).toBe(false);
    const explanation = await rbac.explain({ id: 'u1' }, 'billing:manage');
    expect(explanation.allowed).toBe(false);
    expect(explanation.reason).toBe('role');
  });

  it('isolates organisation and team scopes', async () => {
    const rbac = createRbac({ store: createMemoryStore(), definition, preventEscalation: false });
    await rbac.admin.assignRole({
      subjectId: 'u1',
      roleKey: 'org-admin',
      scope: { orgId: 'org-a' },
    });
    await rbac.admin.assignRole({
      subjectId: 'u1',
      roleKey: 'viewer',
      scope: { orgId: 'org-a', teamId: 'team-1' },
    });

    expect(
      await rbac.can({ id: 'u1' }, 'posts:write', undefined, { scope: { orgId: 'org-a' } }),
    ).toBe(true);
    expect(
      await rbac.can({ id: 'u1' }, 'posts:write', undefined, { scope: { orgId: 'org-b' } }),
    ).toBe(false);
    expect(
      await rbac.can({ id: 'u1' }, 'comments:read', undefined, {
        scope: { orgId: 'org-a', teamId: 'team-1' },
      }),
    ).toBe(true);
    expect(
      await rbac.can({ id: 'u1' }, 'comments:read', undefined, {
        scope: { orgId: 'org-a', teamId: 'team-2' },
      }),
    ).toBe(false);
  });

  it('honours resource grants and ownership', async () => {
    const rbac = createRbac({ store: createMemoryStore(), definition, preventEscalation: false });
    await rbac.admin.grant({
      subjectId: 'u1',
      resourceType: 'posts',
      resourceId: 'p1',
      permissions: ['posts:delete'],
    });
    expect(await rbac.can({ id: 'u1' }, 'posts:delete', { type: 'posts', id: 'p1' })).toBe(true);
    expect(await rbac.can({ id: 'u1' }, 'posts:delete', { type: 'posts', id: 'p2' })).toBe(false);
    expect(
      await rbac.can({ id: 'u1' }, 'posts:write', { type: 'posts', id: 'p2', ownerId: 'u1' }),
    ).toBe(true);
    expect(
      await rbac.can({ id: 'u1' }, 'posts:write', { type: 'posts', id: 'p2', ownerId: 'other' }),
    ).toBe(false);
  });

  it('supports check, canAll, canAny, explain and snapshots', async () => {
    const rbac = createRbac({ store: createMemoryStore(), definition, preventEscalation: false });
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'editor' });
    await expect(rbac.check({ id: 'u1' }, 'posts:read')).resolves.toBeUndefined();
    await expect(rbac.check({ id: 'u1' }, 'posts:delete')).rejects.toBeInstanceOf(
      RbacForbiddenError,
    );
    expect(await rbac.canAll({ id: 'u1' }, ['posts:read', 'posts:write'])).toBe(true);
    expect(await rbac.canAny({ id: 'u1' }, ['posts:delete', 'posts:read'])).toBe(true);

    const snapshot = await rbac.createPermissionSnapshot(
      { id: 'u1' },
      { permissions: ['posts:read', 'posts:delete'] },
    );
    expect(snapshot.decisions['posts:read']).toBe(true);
    expect(snapshot.decisions['posts:delete']).toBe(false);
    const evalr = createSnapshotEvaluator(snapshot);
    expect(evalr.can('posts:read')).toBe(true);
    expect(evalr.can('posts:delete')).toBe(false);
  });

  it('applies deny policies across orgs', async () => {
    const rbac = createRbac({ store: createMemoryStore(), definition, preventEscalation: false });
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'editor' });
    expect(
      await rbac.can({ id: 'u1', orgId: 'org-a' }, 'posts:write', {
        type: 'posts',
        id: 'p1',
        orgId: 'org-b',
      }),
    ).toBe(false);
  });
});
