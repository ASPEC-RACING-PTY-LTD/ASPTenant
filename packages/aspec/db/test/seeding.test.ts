import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client.js';
import { DbErrorCode } from '../src/errors.js';
import { createSeeder } from '../src/seeding.js';
import { factories, tempDir } from './helpers.js';

for (const factory of factories.filter(
  (f) => f.name.includes('memory') || f.name === 'pg (PostgreSQL)',
)) {
  describe.skipIf(!factory.enabled)(`seeding: ${factory.name}`, () => {
    let db: Database;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const created = await factory.create();
      db = created.db;
      cleanup = created.cleanup;
      await db.query('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    });

    afterEach(async () => {
      await cleanup();
    });

    it('runs seeds idempotently from functions and files', async () => {
      const dir = tempDir();
      try {
        writeFileSync(
          join(dir.path, '01_alice.sql'),
          "INSERT INTO people (id, name) VALUES (1, 'alice');",
        );
        const seeder = createSeeder(db, {
          directory: dir.path,
          seeds: [
            {
              id: '02_bob',
              run: async (client) => {
                await client.query('INSERT INTO people (id, name) VALUES ($1, $2)', [2, 'bob']);
              },
            },
          ],
          environment: 'test',
        });
        const first = await seeder.run();
        expect(first.applied).toEqual(['01_alice', '02_bob']);
        const second = await seeder.run();
        expect(second.applied).toEqual([]);
        expect(second.skipped).toEqual(['01_alice', '02_bob']);
        const { rows } = await db.query<{ name: string }>('SELECT name FROM people ORDER BY id');
        expect(rows.map((r) => r.name)).toEqual(['alice', 'bob']);
      } finally {
        dir.cleanup();
      }
    });

    it('refuses production seeding unless forced', async () => {
      const seeder = createSeeder(db, {
        seeds: [{ id: 'x', run: "INSERT INTO people (id, name) VALUES (9, 'x')" }],
        environment: 'production',
      });
      await expect(seeder.run()).rejects.toMatchObject({ code: DbErrorCode.SEED_REFUSED });
      await seeder.run({ force: true });
      expect((await db.query('SELECT name FROM people WHERE id = 9')).rows).toHaveLength(1);
    });
  });
}
