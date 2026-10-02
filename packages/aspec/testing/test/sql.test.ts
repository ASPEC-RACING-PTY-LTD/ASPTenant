import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupAll,
  createPostgresClient,
  createSqliteClient,
  migrate,
  truncateTables,
  withTransactionRollback,
} from '../src/index.js';

const migrations = [
  {
    id: '001_items',
    sqlite: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL);',
    postgres: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL);',
  },
] as const;

afterEach(async () => {
  await cleanupAll();
});

describe.each([
  {
    name: 'sqlite',
    enabled: true,
    create: async () => {
      const client = createSqliteClient();
      return client;
    },
  },
  {
    name: 'postgres',
    enabled: Boolean(process.env.ASPEC_TEST_POSTGRES_URL),
    create: async () => {
      const url = process.env.ASPEC_TEST_POSTGRES_URL;
      if (!url) throw new Error('ASPEC_TEST_POSTGRES_URL is required for this case');
      return createPostgresClient({ url });
    },
  },
] as const)('sql fixtures ($name)', ({ name, enabled, create }) => {
  describe.skipIf(!enabled)(name, () => {
    it('applies migrations, truncates and supports $n params', async () => {
      const db = await create();
      try {
        const ran = await migrate(db, migrations);
        expect(ran).toEqual(['001_items']);
        expect(await migrate(db, migrations)).toEqual([]);

        await db.query('INSERT INTO items (id, name) VALUES ($1, $2)', ['1', 'alpha']);
        const rows = await db.query<{ name: string }>('SELECT name FROM items WHERE id = $1', [
          '1',
        ]);
        expect(rows.rows[0]?.name).toBe('alpha');

        await truncateTables(db, ['items']);
        expect((await db.query('SELECT * FROM items')).rowCount).toBe(0);

        await expect(db.query('SELECT 1; SELECT 2', [1])).rejects.toThrow(/exactly one statement/);
      } finally {
        await db.close();
      }
    });

    it('isolates writes with transaction rollback', async () => {
      const db = await create();
      try {
        await migrate(db, migrations);
        await withTransactionRollback(db, async (tx) => {
          await tx.query('INSERT INTO items (id, name) VALUES ($1, $2)', ['1', 'temp']);
          expect((await tx.query('SELECT * FROM items')).rowCount).toBe(1);
        });
        expect((await db.query('SELECT * FROM items')).rowCount).toBe(0);
      } finally {
        await db.close();
      }
    });

    it('runs parameterless multi-statement scripts', async () => {
      const db = await create();
      try {
        await db.query('CREATE TABLE a (id INT); CREATE TABLE b (id INT);');
        await db.query('INSERT INTO a (id) VALUES ($1)', [1]);
        expect((await db.query('SELECT * FROM a')).rowCount).toBe(1);
      } finally {
        await db.close();
      }
    });
  });
});

describe('postgres schema lifecycle', () => {
  it.skipIf(!process.env.ASPEC_TEST_POSTGRES_URL)(
    'creates and drops an isolated schema',
    async () => {
      const url = process.env.ASPEC_TEST_POSTGRES_URL as string;
      const db = await createPostgresClient({ url });
      expect(db.schema).toMatch(/^test_[a-f0-9]+$/);
      await db.query('CREATE TABLE t (id INT)');
      await db.close();
    },
  );
});
