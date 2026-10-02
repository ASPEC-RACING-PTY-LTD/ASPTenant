import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsersError } from '../src/errors.js';
import type { UsersStore } from '../src/store.js';
import { createMigrations, createSqlUsersStore, migrate, migrations } from '../src/stores/sql.js';
import type { ActivityEvent, InvitationRecord, User } from '../src/types.js';
import { allBackends } from './helpers/backends.js';
import { createSqliteClient } from './helpers/sql.js';

function user(id: string, email: string, overrides: Partial<User> = {}): User {
  return {
    id,
    email,
    status: 'active',
    externalId: null,
    authProvider: null,
    profile: {
      displayName: `Name ${id}`,
      avatarUrl: null,
      locale: null,
      timezone: null,
      bio: null,
      fields: { a: [1, 2] },
    },
    settings: { s: true },
    preferences: { theme: 'dark' },
    metadata: { roles: ['x'] },
    suspension: null,
    deletion: null,
    createdAt: 1000,
    updatedAt: 1000,
    activatedAt: 1000,
    lastLoginAt: null,
    purgedAt: null,
    version: 1,
    ...overrides,
  };
}

function invitation(
  id: string,
  email: string,
  overrides: Partial<InvitationRecord> = {},
): InvitationRecord {
  return {
    id,
    email,
    status: 'pending',
    roles: ['admin', 'billing'],
    metadata: { team: 'core' },
    invitedBy: 'admin-1',
    userId: null,
    tokenHash: 'a'.repeat(64),
    expiresAt: 10_000,
    createdAt: 1000,
    updatedAt: 1000,
    lastSentAt: null,
    sendCount: 0,
    acceptedAt: null,
    revokedAt: null,
    version: 1,
    ...overrides,
  };
}

function event(id: string, userId: string, at: number, type = 'login'): ActivityEvent {
  return {
    id,
    userId,
    type,
    at,
    actorId: null,
    ip: '127.0.0.1',
    userAgent: 'ua',
    metadata: { n: at },
  };
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof UsersError && e.code === code);
}

for (const backend of allBackends()) {
  describe.skipIf(backend.skip)(`UsersStore contract: ${backend.name}`, () => {
    let store: UsersStore;
    beforeAll(async () => {
      await backend.init();
    });
    afterAll(async () => {
      await backend.close();
    });
    const fresh = async () => {
      store = await backend.fresh();
    };

    it('round-trips users with JSON fields and numbers', async () => {
      await fresh();
      const u = user('u1', 'a@example.com', {
        suspension: {
          reason: 'r',
          actorId: null,
          suspendedAt: 5,
          until: null,
          previousStatus: 'active',
        },
      });
      await store.insertUser(u);
      expect(await store.getUser('u1')).toEqual(u);
      expect(await store.getUserByEmail('a@example.com')).toEqual(u);
      expect(await store.getUser('missing')).toBeNull();
    });

    it('enforces unique id, email and external identity', async () => {
      await fresh();
      await store.insertUser(
        user('u1', 'a@example.com', { authProvider: 'okta', externalId: 'sub-1' }),
      );
      await expectCode(store.insertUser(user('u1', 'b@example.com')), 'USERS_ID_TAKEN');
      await expectCode(store.insertUser(user('u2', 'a@example.com')), 'USERS_EMAIL_TAKEN');
      await expectCode(
        store.insertUser(
          user('u3', 'c@example.com', { authProvider: 'okta', externalId: 'sub-1' }),
        ),
        'USERS_EXTERNAL_ID_TAKEN',
      );
      await store.insertUser(
        user('u4', 'd@example.com', { authProvider: 'google', externalId: 'sub-1' }),
      );
      expect((await store.getUserByExternalId('okta', 'sub-1'))?.id).toBe('u1');
      expect((await store.getUserByExternalId('google', 'sub-1'))?.id).toBe('u4');
      const u4 = (await store.getUser('u4')) as User;
      await expectCode(
        store.updateUser({ ...u4, email: 'a@example.com', version: 2 }, 1),
        'USERS_EMAIL_TAKEN',
      );
    });

    it('applies optimistic concurrency on update', async () => {
      await fresh();
      await store.insertUser(user('u1', 'a@example.com'));
      const next = { ...user('u1', 'new@example.com'), version: 2 };
      expect(await store.updateUser(next, 1)).toBe(true);
      expect(await store.updateUser({ ...next, version: 3 }, 1)).toBe(false);
      expect(await store.getUserByEmail('a@example.com')).toBeNull();
      expect((await store.getUserByEmail('new@example.com'))?.version).toBe(2);
    });

    it('lists users with keyset pagination, status and search filters', async () => {
      await fresh();
      for (let i = 0; i < 5; i++) {
        await store.insertUser(
          user(`u${i}`, `user${i}@example.com`, {
            createdAt: 1000 + i,
            status: i % 2 ? 'pending' : 'active',
          }),
        );
      }
      const first = await store.listUsers({ limit: 2 });
      expect(first.map((u) => u.id)).toEqual(['u0', 'u1']);
      const last = first[1] as User;
      const second = await store.listUsers({
        limit: 2,
        after: { createdAt: last.createdAt, id: last.id },
      });
      expect(second.map((u) => u.id)).toEqual(['u2', 'u3']);
      expect((await store.listUsers({ limit: 10, status: 'pending' })).map((u) => u.id)).toEqual([
        'u1',
        'u3',
      ]);
      expect((await store.listUsers({ limit: 10, search: 'user3@' })).map((u) => u.id)).toEqual([
        'u3',
      ]);
      expect((await store.listUsers({ limit: 10, search: 'name u4' })).map((u) => u.id)).toEqual([
        'u4',
      ]);
      expect(await store.listUsers({ limit: 10, search: '%' })).toEqual([]);
    });

    it('finds users due for purge and expired suspensions', async () => {
      await fresh();
      await store.insertUser(
        user('d1', 'd1@example.com', {
          status: 'deleted',
          deletion: {
            requestedAt: 1,
            purgeAfter: 50,
            actorId: null,
            reason: null,
            previousStatus: 'active',
          },
        }),
      );
      await store.insertUser(
        user('d2', 'd2@example.com', {
          status: 'deleted',
          deletion: {
            requestedAt: 1,
            purgeAfter: 500,
            actorId: null,
            reason: null,
            previousStatus: 'active',
          },
        }),
      );
      await store.insertUser(
        user('s1', 's1@example.com', {
          status: 'suspended',
          suspension: {
            reason: 'x',
            actorId: null,
            suspendedAt: 1,
            until: 60,
            previousStatus: 'active',
          },
        }),
      );
      await store.insertUser(
        user('s2', 's2@example.com', {
          status: 'suspended',
          suspension: {
            reason: 'x',
            actorId: null,
            suspendedAt: 1,
            until: null,
            previousStatus: 'active',
          },
        }),
      );
      expect((await store.listDueForPurge(100, 10)).map((u) => u.id)).toEqual(['d1']);
      expect((await store.listExpiredSuspensions(100, 10)).map((u) => u.id)).toEqual(['s1']);
    });

    it('deletes a user with its tokens and activity', async () => {
      await fresh();
      await store.insertUser(user('u1', 'a@example.com'));
      await store.insertActivationToken({
        id: 't1',
        userId: 'u1',
        tokenHash: 'h',
        createdAt: 1,
        expiresAt: 2,
        usedAt: null,
      });
      await store.appendActivity(event('e1', 'u1', 5));
      expect(await store.deleteUser('u1')).toBe(true);
      expect(await store.getUser('u1')).toBeNull();
      expect(await store.getActivationToken('t1')).toBeNull();
      expect(await store.listActivity('u1', { limit: 10 })).toEqual([]);
      expect(await store.deleteUser('u1')).toBe(false);
      await store.insertUser(user('u1', 'a@example.com'));
    });

    it('marks activation tokens used exactly once', async () => {
      await fresh();
      const rec = {
        id: 't1',
        userId: 'u1',
        tokenHash: 'h',
        createdAt: 1,
        expiresAt: 2,
        usedAt: null,
      };
      await store.insertActivationToken(rec);
      expect(await store.getActivationToken('t1')).toEqual(rec);
      expect(await store.markActivationTokenUsed('t1', 9)).toBe(true);
      expect(await store.markActivationTokenUsed('t1', 10)).toBe(false);
      expect((await store.listActivationTokens('u1'))[0]?.usedAt).toBe(9);
      await store.deleteActivationTokens('u1');
      expect(await store.listActivationTokens('u1')).toEqual([]);
    });

    it('stores invitations with one pending invitation per email', async () => {
      await fresh();
      const inv = invitation('i1', 'x@example.com');
      await store.insertInvitation(inv);
      expect(await store.getInvitation('i1')).toEqual(inv);
      expect((await store.findPendingInvitation('x@example.com'))?.id).toBe('i1');
      await expectCode(
        store.insertInvitation(invitation('i2', 'x@example.com')),
        'USERS_INVITATION_EXISTS',
      );
      const accepted = {
        ...inv,
        status: 'accepted' as const,
        userId: 'u1',
        acceptedAt: 5,
        version: 2,
      };
      expect(await store.updateInvitation(accepted, 1)).toBe(true);
      expect(await store.updateInvitation({ ...accepted, version: 3 }, 1)).toBe(false);
      expect(await store.findPendingInvitation('x@example.com')).toBeNull();
      await store.insertInvitation(invitation('i2', 'x@example.com', { createdAt: 2000 }));
      await store.insertInvitation(invitation('i3', 'y@example.com', { createdAt: 3000 }));
      expect((await store.listInvitations({ limit: 10 })).map((i) => i.id)).toEqual([
        'i1',
        'i2',
        'i3',
      ]);
      expect(
        (await store.listInvitations({ limit: 10, status: 'pending' })).map((i) => i.id),
      ).toEqual(['i2', 'i3']);
      expect(
        (await store.listInvitations({ limit: 10, email: 'x@example.com' })).map((i) => i.id),
      ).toEqual(['i1', 'i2']);
      expect(
        (await store.listInvitations({ limit: 10, after: { createdAt: 1000, id: 'i1' } })).map(
          (i) => i.id,
        ),
      ).toEqual(['i2', 'i3']);
      expect(await store.deleteInvitationsByEmail('x@example.com')).toBe(2);
      expect((await store.listInvitations({ limit: 10 })).map((i) => i.id)).toEqual(['i3']);
    });

    it('lists activity newest first with keyset pagination, type filter and pruning', async () => {
      await fresh();
      await store.appendActivity(event('e1', 'u1', 100));
      await store.appendActivity(event('e2', 'u1', 200, 'profile.updated'));
      await store.appendActivity(event('e3', 'u1', 200));
      await store.appendActivity(event('e4', 'u1', 300));
      await store.appendActivity(event('e5', 'u2', 50));
      const page1 = await store.listActivity('u1', { limit: 2 });
      expect(page1.map((e) => e.id)).toEqual(['e4', 'e3']);
      const last = page1[1] as ActivityEvent;
      const page2 = await store.listActivity('u1', {
        limit: 5,
        before: { at: last.at, id: last.id },
      });
      expect(page2.map((e) => e.id)).toEqual(['e2', 'e1']);
      expect(
        (await store.listActivity('u1', { limit: 5, type: 'profile.updated' })).map((e) => e.id),
      ).toEqual(['e2']);
      expect(page1[0]).toEqual(event('e4', 'u1', 300));
      expect(await store.pruneActivity(150)).toBe(2);
      expect((await store.listActivity('u1', { limit: 10 })).map((e) => e.id)).toEqual([
        'e4',
        'e3',
        'e2',
      ]);
      expect(await store.deleteActivity('u1')).toBe(3);
    });
  });
}

describe('SQL migrations', () => {
  it('are idempotent and honour a custom table prefix', async () => {
    const client = createSqliteClient();
    await migrate(client, { tablePrefix: 'acct_' });
    await migrate(client, { tablePrefix: 'acct_' });
    const applied = await client.query<{ id: string }>('SELECT id FROM acct_schema_migrations');
    expect(applied.rows.map((r) => r.id)).toEqual(['0001_initial']);
    const store = createSqlUsersStore(client, { tablePrefix: 'acct_' });
    await store.insertUser(user('u1', 'a@example.com'));
    expect((await store.getUser('u1'))?.email).toBe('a@example.com');
    client.close();
  });

  it('rejects unsafe table prefixes', () => {
    expect(() => createMigrations('users; drop table x')).toThrow(UsersError);
    expect(() => createSqlUsersStore(createSqliteClient(), { tablePrefix: 'Bad-Prefix' })).toThrow(
      /tablePrefix/,
    );
  });

  it('exports default migrations for both dialects', () => {
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.postgres).toContain('JSONB');
    expect(migrations[0]?.sqlite).not.toContain('JSONB');
    expect(migrations[0]?.postgres).toContain('users_accounts');
  });
});
