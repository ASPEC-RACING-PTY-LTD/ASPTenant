import { afterAll, describe, expect, it } from 'vitest';
import { createApiKeys } from '../src/service.js';
import { createMemoryStore } from '../src/stores/memory.js';
import { createSqlStore, migrate } from '../src/stores/sql.js';
import { createPostgresClient } from './helpers/postgres.js';
import { createSqliteClient } from './helpers/sql.js';

const PEPPER = Buffer.alloc(32, 3);
const pgUrl = process.env.ASPEC_TEST_POSTGRES_URL;

async function contract(
  name: string,
  build: () => Promise<{
    api: ReturnType<typeof createApiKeys>;
    close: () => Promise<void>;
  }>,
) {
  describe(name, () => {
    let api: ReturnType<typeof createApiKeys>;
    let close: () => Promise<void>;
    afterAll(async () => {
      await api.shutdown();
      await close();
    });

    it('runs migrations and CRUD', async () => {
      ({ api, close } = await build());
      const created = await api.create({
        name: 'k',
        scopes: ['read:x'],
        ownerType: 'user',
        ownerId: 'u1',
      });
      expect(await api.get(created.key.id)).toMatchObject({ name: 'k' });
      const listed = await api.list({ ownerId: 'u1' });
      expect(listed.items).toHaveLength(1);
      expect((await api.verify(created.secret)).ok).toBe(true);
      await api.revoke(created.key.id);
      expect((await api.verify(created.secret)).ok).toBe(false);
    });
  });
}

await contract('memory store', async () => {
  const api = createApiKeys({
    store: createMemoryStore(),
    pepper: PEPPER,
    nodeEnv: 'test',
    usageFlushIntervalMs: 0,
    verificationFailureSampleRate: 0,
  });
  return { api, close: async () => undefined };
});

await contract('sqlite store', async () => {
  const client = createSqliteClient();
  await migrate(client);
  const api = createApiKeys({
    store: createSqlStore(client),
    pepper: PEPPER,
    nodeEnv: 'test',
    usageFlushIntervalMs: 0,
    verificationFailureSampleRate: 0,
  });
  return {
    api,
    close: async () => {
      client.close();
    },
  };
});

describe.skipIf(!pgUrl)('postgres store', () => {
  it('runs migrations and CRUD', async () => {
    const client = await createPostgresClient(pgUrl!);
    try {
      await migrate(client);
      const api = createApiKeys({
        store: createSqlStore(client),
        pepper: PEPPER,
        nodeEnv: 'test',
        usageFlushIntervalMs: 0,
        verificationFailureSampleRate: 0,
      });
      const created = await api.create({
        name: 'pg',
        scopes: ['read:x'],
        ownerType: 'user',
        ownerId: 'u1',
      });
      expect((await api.verify(created.secret)).ok).toBe(true);
      const version = await client.query<{ server_version: string }>('SHOW server_version');
      console.log(`PostgreSQL server_version: ${version.rows[0]?.server_version}`);
      await api.shutdown();
    } finally {
      await client.close();
    }
  });
});
