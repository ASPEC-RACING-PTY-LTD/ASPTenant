import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgsError } from '../src/errors.js';
import { createMigrations, migrate, migrations } from '../src/stores/sql.js';
import type { InvitationRecord, Membership, Organisation } from '../src/types.js';
import { allBackends } from './helpers/backends.js';

function org(id: string, slug: string): Organisation {
  return {
    id,
    name: `Org ${id}`,
    slug,
    status: 'active',
    metadata: {},
    settings: {},
    createdBy: 'u1',
    createdAt: 1000,
    updatedAt: 1000,
    archivedAt: null,
    deletedAt: null,
    version: 1,
  };
}

function member(id: string, orgId: string, userId: string): Membership {
  return {
    id,
    orgId,
    userId,
    role: 'member',
    status: 'active',
    invitedAt: null,
    joinedAt: 1000,
    suspendedAt: null,
    removedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    version: 1,
  };
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof OrgsError && e.code === code);
}

for (const backend of allBackends()) {
  describe.skipIf(backend.skip)(`OrgsStore contract: ${backend.name}`, () => {
    beforeAll(async () => {
      await backend.init();
    });
    afterAll(async () => {
      await backend.close();
    });

    it('inserts and loads organisations by id and slug', async () => {
      const store = await backend.fresh();
      const created = await store.insertOrg(org('o1', 'alpha'));
      expect(created.slug).toBe('alpha');
      expect(await store.getOrg('o1')).toMatchObject({ id: 'o1', slug: 'alpha' });
      expect(await store.getOrgBySlug('alpha')).toMatchObject({ id: 'o1' });
    });

    it('enforces slug uniqueness and version conflicts', async () => {
      const store = await backend.fresh();
      await store.insertOrg(org('o1', 'one'));
      await expectCode(store.insertOrg(org('o2', 'one')), 'ORGS_SLUG_TAKEN');
      const cur = (await store.getOrg('o1'))!;
      await store.updateOrg({ ...cur, name: 'Renamed', updatedAt: 2000 }, cur.version);
      await expectCode(
        store.updateOrg({ ...cur, name: 'Stale', updatedAt: 3000 }, cur.version),
        'ORGS_VERSION_CONFLICT',
      );
    });

    it('stores memberships and counts owners', async () => {
      const store = await backend.fresh();
      await store.insertOrg(org('o1', 'mem'));
      await store.insertMembership({ ...member('m1', 'o1', 'u1'), role: 'owner' });
      await store.insertMembership(member('m2', 'o1', 'u2'));
      expect(await store.countOwners('o1')).toBe(1);
      expect(await store.getMembership('o1', 'u2')).toMatchObject({ userId: 'u2' });
    });

    it('stores invitations without exposing token hash via public paths', async () => {
      const store = await backend.fresh();
      await store.insertOrg(org('o1', 'inv'));
      const inv: InvitationRecord = {
        id: 'i1',
        orgId: 'o1',
        email: 'a@example.com',
        role: 'member',
        teamIds: [],
        status: 'pending',
        invitedBy: 'u1',
        tokenHash: 'a'.repeat(64),
        expiresAt: 10_000,
        createdAt: 1000,
        updatedAt: 1000,
        lastSentAt: null,
        sendCount: 0,
        acceptedAt: null,
        revokedAt: null,
        version: 1,
      };
      await store.insertInvitation(inv);
      const loaded = await store.getPendingInvitationByEmail('o1', 'a@example.com');
      expect(loaded?.tokenHash).toBe('a'.repeat(64));
    });
  });
}

describe('SQL migrations', () => {
  it('exports initial migration for both dialects', () => {
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.postgres).toContain('organisations');
    expect(migrations[0]?.sqlite).toContain('organisations');
    expect(createMigrations('app_orgs_')[0]?.postgres).toContain('app_orgs_organisations');
  });

  it('migrate is idempotent on sqlite', async () => {
    const { createSqliteClient } = await import('./helpers/sql.js');
    const client = createSqliteClient();
    await migrate(client);
    await migrate(client);
    client.close();
  });
});
