import { afterAll, describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth.js';
import type { AuthStore } from '../src/store.js';
import { createMemoryAuthStore } from '../src/stores/memory.js';
import { createSqlAuthStore, migrate } from '../src/stores/sql.js';
import { mutableClock, STRONG_PASSWORD, testHasher } from './helpers/setup.js';
import { createPostgresClient, createSqliteClient } from './helpers/sql.js';

async function runContract(
  name: string,
  createStore: () => Promise<{ store: AuthStore; close: () => Promise<void> }>,
) {
  describe(name, () => {
    let close: () => Promise<void> = async () => undefined;
    afterAll(async () => {
      await close();
    });

    it('supports register, login, sessions and identities', async () => {
      const created = await createStore();
      close = created.close;
      const clock = mutableClock();
      const auth = createAuth({ store: created.store, clock, hasher: testHasher });
      const reg = await auth.register({ email: 'store@example.com', password: STRONG_PASSWORD });
      const login = await auth.login({ email: 'store@example.com', password: STRONG_PASSWORD });
      expect(login.status).toBe('authenticated');
      if (login.status !== 'authenticated') return;
      const sessions = await auth.listSessions(reg.account.id, login.session.id);
      expect(sessions.some((s) => s.current)).toBe(true);
      expect(
        await created.store.createIdentity({
          id: 'id1',
          accountId: reg.account.id,
          provider: 'github',
          subject: '42',
          email: 'store@example.com',
          createdAt: clock.now(),
          lastLoginAt: null,
        }),
      ).toBe(true);
      expect((await created.store.getIdentity('github', '42'))?.accountId).toBe(reg.account.id);
      expect(await auth.purgeExpired()).toBeGreaterThanOrEqual(0);
    });
  });
}

await runContract('memory store', async () => {
  const store = createMemoryAuthStore({ sweepIntervalMs: 0 });
  return { store, close: async () => undefined };
});

await runContract('sqlite store', async () => {
  const client = createSqliteClient();
  await migrate(client);
  return {
    store: createSqlAuthStore(client),
    close: async () => {
      client.close();
    },
  };
});

const pgUrl = process.env.ASPEC_TEST_POSTGRES_URL;
describe.skipIf(!pgUrl)('postgres store', () => {
  let close: () => Promise<void> = async () => undefined;
  afterAll(async () => {
    await close();
  });

  it('runs migrations and auth flows', async () => {
    const client = await createPostgresClient(pgUrl as string);
    close = () => client.close();
    await migrate(client);
    const version = await client.query<{ server_version: string }>('SHOW server_version');
    expect(version.rows[0]?.server_version).toBeTruthy();
    const clock = mutableClock();
    const auth = createAuth({ store: createSqlAuthStore(client), clock, hasher: testHasher });
    await auth.register({ email: 'pg@example.com', password: STRONG_PASSWORD });
    const login = await auth.login({ email: 'pg@example.com', password: STRONG_PASSWORD });
    expect(login.status).toBe('authenticated');
  });
});
