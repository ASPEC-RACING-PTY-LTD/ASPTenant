import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client.js';
import { DbErrorCode } from '../src/errors.js';
import {
  checksumSql,
  createMigrationFile,
  createMigrator,
  parseMigrationSql,
} from '../src/migrations.js';
import { factories, tempDir } from './helpers.js';

describe('parseMigrationSql', () => {
  it('splits up/down and respects no-transaction', () => {
    const parsed = parseMigrationSql(`
-- migrate:up
CREATE TABLE t (id INT);
-- migrate:down
DROP TABLE t;
-- migrate:no-transaction
`);
    expect(parsed.up).toContain('CREATE TABLE t');
    expect(parsed.down).toContain('DROP TABLE t');
    expect(parsed.transaction).toBe(false);
  });

  it('checksums normalise line endings', () => {
    expect(checksumSql('SELECT 1;\r\n')).toBe(checksumSql('SELECT 1;\n'));
  });
});

for (const factory of factories) {
  describe.skipIf(!factory.enabled)(`migrations: ${factory.name}`, () => {
    let db: Database;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const created = await factory.create();
      db = created.db;
      cleanup = created.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    it('applies programmatic migrations, reports status and rolls back', async () => {
      const migrator = createMigrator(db, {
        migrations: [
          {
            id: '0001_a',
            up: 'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)',
            down: 'DROP TABLE a',
          },
          {
            id: '0002_b',
            up: 'CREATE TABLE b (id INTEGER PRIMARY KEY)',
            down: 'DROP TABLE b',
          },
        ],
      });
      expect((await migrator.status()).map((s) => s.state)).toEqual(['pending', 'pending']);
      const up = await migrator.up();
      expect(up.migrations).toEqual(['0001_a', '0002_b']);
      await db.query('INSERT INTO a (id, v) VALUES ($1, $2)', [1, 'x']);
      expect((await migrator.status()).every((s) => s.state === 'applied')).toBe(true);
      const down = await migrator.rollback({ steps: 1 });
      expect(down.migrations).toEqual(['0002_b']);
      await expect(db.query('SELECT 1 FROM b')).rejects.toThrow();
      await db.query('SELECT 1 FROM a');
    });

    it('loads file migrations and stops at --to', async () => {
      const dir = tempDir();
      try {
        writeFileSync(
          join(dir.path, '0001_init.sql'),
          '-- migrate:up\nCREATE TABLE files (id INTEGER PRIMARY KEY);\n-- migrate:down\nDROP TABLE files;\n',
        );
        writeFileSync(
          join(dir.path, '0002_more.sql'),
          '-- migrate:up\nCREATE TABLE more (id INTEGER PRIMARY KEY);\n-- migrate:down\nDROP TABLE more;\n',
        );
        const migrator = createMigrator(db, { directory: dir.path });
        const result = await migrator.up({ to: '0001_init' });
        expect(result.migrations).toEqual(['0001_init']);
        await db.query('SELECT 1 FROM files');
        await expect(db.query('SELECT 1 FROM more')).rejects.toThrow();
      } finally {
        dir.cleanup();
      }
    });

    it('refuses when an applied migration checksum changed', async () => {
      const migrator = createMigrator(db, {
        migrations: [
          { id: '0001_x', up: 'CREATE TABLE x (id INTEGER PRIMARY KEY)', down: 'DROP TABLE x' },
        ],
      });
      await migrator.up();
      const changed = createMigrator(db, {
        migrations: [
          {
            id: '0001_x',
            up: 'CREATE TABLE x (id INTEGER PRIMARY KEY, v TEXT)',
            down: 'DROP TABLE x',
          },
        ],
      });
      await expect(changed.up()).rejects.toMatchObject({
        code: DbErrorCode.MIGRATION_CHECKSUM_MISMATCH,
      });
      await expect(changed.status()).resolves.toMatchObject([{ state: 'changed' }]);
    });

    it('runs function steps and no-transaction migrations', async () => {
      let calls = 0;
      const migrator = createMigrator(db, {
        migrations: [
          {
            id: '0001_fn',
            checksum: 'abc',
            up: async (client) => {
              calls++;
              await client.query('CREATE TABLE fn (id INTEGER PRIMARY KEY)');
            },
            down: async (client) => {
              await client.query('DROP TABLE fn');
            },
          },
          {
            id: '0002_nt',
            transaction: false,
            up: 'CREATE TABLE nt (id INTEGER PRIMARY KEY)',
            down: 'DROP TABLE nt',
          },
        ],
      });
      await migrator.up();
      expect(calls).toBe(1);
      await db.query('INSERT INTO fn (id) VALUES ($1)', [1]);
      await db.query('INSERT INTO nt (id) VALUES ($1)', [1]);
      await migrator.down({ steps: 2 });
    });

    it('creates a migration file without overwriting', async () => {
      const dir = tempDir();
      try {
        mkdirSync(dir.path, { recursive: true });
        const first = await createMigrationFile(dir.path, 'Add Users', {
          clock: { now: () => 1_725_000_000_000 },
        });
        expect(first.id).toMatch(/^\d+_add_users$/);
        await expect(
          createMigrationFile(dir.path, 'Add Users', { clock: { now: () => 1_725_000_000_000 } }),
        ).rejects.toMatchObject({
          code: DbErrorCode.MIGRATION_INVALID,
        });
      } finally {
        dir.cleanup();
      }
    });
  });
}

describe.skipIf(!factories.find((f) => f.name === 'pg (PostgreSQL)')?.enabled)(
  'concurrent migration locking (PostgreSQL)',
  () => {
    it('serialises two runners with advisory locks', async () => {
      const factory = factories.find((f) => f.name === 'pg (PostgreSQL)');
      if (!factory) return;
      const a = await factory.create();
      try {
        const schema = (await a.db.query<{ schema: string }>('SELECT current_schema() AS schema'))
          .rows[0]?.schema as string;
        const { createPostgresClient } = await import('../src/drivers/postgres.js');
        const { PG_URL } = await import('./helpers.js');
        const shared = createPostgresClient({
          url: PG_URL as string,
          searchPath: [schema],
        });
        await shared.connect();
        const migrations = [
          {
            id: '0001_lock',
            up: async (client: { query: Database['query'] }) => {
              await client.query('SELECT pg_sleep(0.25)');
              await client.query('CREATE TABLE lock_t (id INTEGER PRIMARY KEY)');
            },
            down: 'DROP TABLE lock_t',
            checksum: 'lock1',
          },
        ];
        try {
          const m1 = createMigrator(a.db, { migrations, lockTimeoutMs: 10_000 });
          const m2 = createMigrator(shared, { migrations, lockTimeoutMs: 10_000 });
          const results = await Promise.all([m1.up(), m2.up()]);
          const applied = results.flatMap((r) => r.migrations);
          expect(applied.filter((id) => id === '0001_lock')).toHaveLength(1);
          expect(
            results.filter((r) => r.migrations.length === 0 || r.skipped.length > 0).length,
          ).toBeGreaterThanOrEqual(1);
          await a.db.query('SELECT 1 FROM lock_t');
        } finally {
          await shared.close();
        }
      } finally {
        await a.cleanup();
      }
    });
  },
);
