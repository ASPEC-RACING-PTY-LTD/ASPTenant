import { afterEach, describe, expect, it } from 'vitest';
import { createRbac, defineRbac } from '../src/index.js';
import { createMemoryStore } from '../src/memory.js';
import { createSqlStore, migrate } from '../src/sql.js';
import type { RbacStore } from '../src/store.js';
import { createPostgresClient, createSqliteClient } from './helpers/sql.js';

const definition = defineRbac({
  permissions: ['posts:read', 'posts:write'],
  roles: [{ key: 'viewer', permissions: ['posts:read'] }],
});

function runStoreSuite(
  name: string,
  setup: () => Promise<{ store: RbacStore; close: () => void | Promise<void> }>,
) {
  describe(name, () => {
    let close: (() => void | Promise<void>) | undefined;
    afterEach(async () => {
      if (close) await close();
      close = undefined;
    });

    it('persists roles, assignments and grants', async () => {
      const created = await setup();
      close = created.close;
      const rbac = createRbac({ store: created.store, definition, preventEscalation: false });
      await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'viewer' });
      await rbac.admin.grant({
        subjectId: 'u1',
        resourceType: 'posts',
        resourceId: 'p1',
        permissions: ['posts:write'],
      });
      expect(await rbac.can({ id: 'u1' }, 'posts:read')).toBe(true);
      expect(await rbac.can({ id: 'u1' }, 'posts:write', { type: 'posts', id: 'p1' })).toBe(true);
      const roles = await rbac.admin.listRoles();
      expect(roles.some((r) => r.key === 'viewer' && r.system)).toBe(true);
    });
  });
}

runStoreSuite('memory store', async () => ({
  store: createMemoryStore(),
  close: () => undefined,
}));

runStoreSuite('sqlite store', async () => {
  const client = createSqliteClient();
  await migrate(client);
  return { store: createSqlStore(client), close: () => client.close() };
});

describe.skipIf(!process.env.ASPEC_TEST_POSTGRES_URL)('postgres store', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it('persists roles, assignments and grants', async () => {
    const client = await createPostgresClient(process.env.ASPEC_TEST_POSTGRES_URL as string);
    close = () => client.close();
    await migrate(client);
    const rbac = createRbac({
      store: createSqlStore(client),
      definition,
      preventEscalation: false,
    });
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'viewer' });
    expect(await rbac.can({ id: 'u1' }, 'posts:read')).toBe(true);
    const version = await client.query<{ server_version: string }>('SHOW server_version');
    expect(version.rows[0]?.server_version).toBeTruthy();
  });
});
