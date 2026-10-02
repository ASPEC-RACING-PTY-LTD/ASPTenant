import { afterAll, describe, expect, it } from 'vitest';
import { parseFilterSort, toSql } from '../src/index.js';
import { createPostgresClient, createSqliteClient, tryLoadPg } from './helpers/sql.js';

const whitelist = {
  status: { column: 'status', operators: ['eq', 'in', 'ne'] as const },
  name: { column: 'name', operators: ['contains', 'eq', 'startsWith'] as const },
  createdAt: {
    column: 'created_at',
    operators: ['gte', 'lte'] as const,
    coerce: (s: string) => Number(s),
  },
};

const seedSql = `
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO items (id, status, name, created_at) VALUES
  ('1', 'active', 'alpha', 10),
  ('2', 'archived', 'beta', 20),
  ('3', 'active', 'gamma', 30);
`;

describe.each([
  [
    'sqlite',
    async () => {
      const client = createSqliteClient();
      await client.query(seedSql);
      return client;
    },
  ],
  [
    'postgres',
    async () => {
      const url = process.env.ASPEC_TEST_POSTGRES_URL;
      if (!url || !tryLoadPg()) return undefined;
      const client = await createPostgresClient(url);
      await client.query(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at BIGINT NOT NULL
        );
        INSERT INTO items (id, status, name, created_at) VALUES
          ('1', 'active', 'alpha', 10),
          ('2', 'archived', 'beta', 20),
          ('3', 'active', 'gamma', 30);
      `);
      return client;
    },
  ],
] as const)('SQL builder (%s)', (label, factory) => {
  const skip = label === 'postgres' && !process.env.ASPEC_TEST_POSTGRES_URL;
  describe.skipIf(skip)(label, () => {
    let client: Awaited<ReturnType<typeof createSqliteClient>> | undefined;
    let closer: (() => void | Promise<void>) | undefined;

    afterAll(async () => {
      await closer?.();
    });

    it('filters with parameters and rejects injection', async () => {
      const created = await factory();
      if (!created) {
        // pg peer missing from this module's package.json
        return;
      }
      client = created as typeof client;
      closer = () => client!.close();

      const ast = parseFilterSort(
        new URLSearchParams(
          "filter[status]=active&filter[name][contains]=a'; drop table items;--&sort=-createdAt",
        ),
        whitelist,
      );
      const frag = toSql(ast, whitelist, client!.dialect);
      expect(frag.sql.toLowerCase()).not.toContain('drop table');
      const sql = `SELECT id, status, name, created_at AS "createdAt" FROM items ${frag.sql}`;
      const result = await client!.query<{ id: string; name: string }>(sql, frag.params);
      expect(result.rows.every((r) => r.name.includes('a') || r.name.includes("a'; drop"))).toBe(
        true,
      );
      // Table still exists (injection did not run)
      const count = await client!.query<{ n: number | string }>('SELECT COUNT(*) AS n FROM items');
      expect(Number(count.rows[0]?.n)).toBe(3);
    });
  });
});
