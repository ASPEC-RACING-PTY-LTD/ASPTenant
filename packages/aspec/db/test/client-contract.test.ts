import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client.js';
import { DbError } from '../src/errors.js';
import type { SqlClient } from '../src/ports.js';
import { withTransaction } from '../src/transaction.js';
import { factories } from './helpers.js';

for (const factory of factories) {
  describe.skipIf(!factory.enabled)(`SqlClient contract: ${factory.name}`, () => {
    let db: Database;
    let cleanup: () => Promise<void>;
    const isPg = factory.dialect === 'postgres';
    const bool = (v: unknown) => (isPg ? v : v === 1);

    beforeEach(async () => {
      const created = await factory.create();
      db = created.db;
      cleanup = created.cleanup;
      await db.query(
        `CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active BOOLEAN, created_at BIGINT, meta TEXT, note TEXT)`,
      );
    });

    afterEach(async () => {
      await cleanup();
    });

    it('reports its dialect and satisfies the SqlClient port', () => {
      const port: SqlClient = db;
      expect(port.dialect).toBe(factory.dialect);
    });

    it('binds $n placeholders, including reused numbers', async () => {
      await db.query('INSERT INTO items (id, name) VALUES ($1, $2)', [1, 'a']);
      const result = await db.query<{ a: unknown; b: unknown; c: unknown }>(
        'SELECT $1::text AS a, $2::text AS b, $1::text AS c'.replace(
          /::text/g,
          isPg ? '::text' : '',
        ),
        ['x', 'y'],
      );
      expect(result.rows).toEqual([{ a: 'x', b: 'y', c: 'x' }]);
      expect(result.rowCount).toBe(1);
    });

    it('does not rewrite placeholders inside literals, identifiers and comments', async () => {
      const result = await db.query<{ lit: string; n: string }>(
        `SELECT '$1 is literal' AS lit, /* $2 */ $1 AS n -- $3\n`,
        ['value'],
      );
      expect(result.rows[0]).toEqual({ lit: '$1 is literal', n: 'value' });
    });

    it('normalises booleans, Dates, undefined and objects', async () => {
      const when = new Date('2026-09-29T00:00:00.000Z');
      await db.query(
        'INSERT INTO items (id, name, active, created_at, meta, note) VALUES ($1, $2, $3, $4, $5, $6)',
        [
          1,
          'n',
          true,
          isPg ? when.getTime() : when,
          isPg ? JSON.stringify({ a: 1 }) : { a: 1 },
          undefined,
        ],
      );
      const { rows } = await db.query<Record<string, unknown>>(
        'SELECT * FROM items WHERE id = $1',
        [1],
      );
      const row = rows[0] as Record<string, unknown>;
      expect(bool(row.active)).toBe(true);
      expect(Number(row.created_at)).toBe(when.getTime());
      expect(JSON.parse(row.meta as string)).toEqual({ a: 1 });
      expect(row.note).toBeNull();
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    });

    it('reports affected rows for writes and RETURNING rows', async () => {
      const inserted = await db.query<{ id: number }>(
        'INSERT INTO items (id, name) VALUES ($1, $2), ($3, $4) RETURNING id',
        [1, 'a', 2, 'b'],
      );
      expect(inserted.rows.map((r) => Number(r.id)).sort()).toEqual([1, 2]);
      expect(inserted.rowCount).toBe(2);
      const updated = await db.query('UPDATE items SET note = $1', ['x']);
      expect(updated.rowCount).toBe(2);
      expect(updated.rows).toEqual([]);
    });

    it('runs parameterless multi-statement scripts', async () => {
      await db.query(`
        -- a migration-style script; semicolons in 'strings;' are not separators
        CREATE TABLE multi_a (id INTEGER PRIMARY KEY, v TEXT);
        INSERT INTO multi_a (id, v) VALUES (1, 'x;y');
        CREATE TABLE multi_b (id INTEGER PRIMARY KEY);
      `);
      const { rows } = await db.query<{ v: string }>('SELECT v FROM multi_a');
      expect(rows).toEqual([{ v: 'x;y' }]);
      await db.query('SELECT 1 FROM multi_b');
    });

    it('rejects parameterised queries with several statements', async () => {
      await expect(db.query('SELECT $1; SELECT 2', [1])).rejects.toThrow();
      if (!isPg) {
        await expect(db.query('SELECT $1; SELECT 2', [1])).rejects.toMatchObject({
          code: 'DB_MULTI_STATEMENT',
        });
      }
    });

    it('rejects a parameter count that does not match the placeholders', async () => {
      await expect(db.query('SELECT $1 AS a, $2 AS b', [1])).rejects.toThrow();
    });

    it('passes driver errors through unchanged (unique violations stay inspectable)', async () => {
      await db.query('INSERT INTO items (id, name) VALUES ($1, $2)', [1, 'dup']);
      const error = await db
        .query('INSERT INTO items (id, name) VALUES ($1, $2)', [2, 'dup'])
        .catch((e) => e);
      expect(error).not.toBeInstanceOf(DbError);
      if (isPg) expect(error.code).toBe('23505');
      else expect(String(error.message)).toMatch(/UNIQUE constraint failed/);
    });

    it('commits and rolls back transactions', async () => {
      await db.transaction(async (tx) => {
        await tx.query('INSERT INTO items (id, name) VALUES ($1, $2)', [1, 'kept']);
      });
      await expect(
        db.transaction(async (tx) => {
          await tx.query('INSERT INTO items (id, name) VALUES ($1, $2)', [2, 'lost']);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const { rows } = await db.query<{ name: string }>('SELECT name FROM items ORDER BY id');
      expect(rows.map((r) => r.name)).toEqual(['kept']);
    });

    it('uses savepoints for nested transactions', async () => {
      await db.transaction(async (tx) => {
        await tx.query('INSERT INTO items (id, name) VALUES ($1, $2)', [1, 'outer']);
        await expect(
          tx.transaction(async (inner) => {
            await inner.query('INSERT INTO items (id, name) VALUES ($1, $2)', [2, 'inner-lost']);
            throw new Error('inner failure');
          }),
        ).rejects.toThrow('inner failure');
        await tx.transaction(async (inner) => {
          await inner.query('INSERT INTO items (id, name) VALUES ($1, $2)', [3, 'inner-kept']);
          await inner.transaction(async (deeper) => {
            await deeper.query('INSERT INTO items (id, name) VALUES ($1, $2)', [4, 'deeper']);
          });
        });
      });
      const { rows } = await db.query<{ name: string }>('SELECT name FROM items ORDER BY id');
      expect(rows.map((r) => r.name)).toEqual(['outer', 'inner-kept', 'deeper']);
    });

    it('joins the ambient transaction when the outer client is used inside it', async () => {
      await expect(
        db.transaction(async () => {
          await db.query('INSERT INTO items (id, name) VALUES ($1, $2)', [1, 'ambient']);
          const inside = await db.query('SELECT name FROM items');
          expect(inside.rows).toHaveLength(1);
          throw new Error('rollback all');
        }),
      ).rejects.toThrow('rollback all');
      expect((await db.query('SELECT name FROM items')).rows).toHaveLength(0);
    });

    it('rejects use of a transaction client after the transaction completed', async () => {
      let leaked: SqlClient | undefined;
      await db.transaction(async (tx) => {
        leaked = tx;
      });
      await expect((leaked as SqlClient).query('SELECT 1')).rejects.toMatchObject({
        code: 'DB_CLOSED',
      });
    });

    it('isolates concurrent transactions', async () => {
      await db.query('INSERT INTO items (id, name, created_at) VALUES ($1, $2, $3)', [
        1,
        'counter',
        0,
      ]);
      await Promise.all(
        Array.from({ length: 8 }, () =>
          withTransaction(
            db,
            async (tx) => {
              const current = await tx.query<{ created_at: number | string }>(
                `SELECT created_at FROM items WHERE id = 1${isPg ? ' FOR UPDATE' : ''}`,
              );
              const next = Number(current.rows[0]?.created_at) + 1;
              await tx.query('UPDATE items SET created_at = $1 WHERE id = 1', [next]);
            },
            { retries: 10 },
          ),
        ),
      );
      const { rows } = await db.query<{ created_at: number | string }>(
        'SELECT created_at FROM items WHERE id = 1',
      );
      expect(Number(rows[0]?.created_at)).toBe(8);
    });

    it('supports read-only transactions', async () => {
      await expect(
        db.transaction(
          async (tx) => tx.query('INSERT INTO items (id, name) VALUES ($1, $2)', [1, 'ro']),
          {
            readOnly: true,
          },
        ),
      ).rejects.toThrow();
      await db.query('INSERT INTO items (id, name) VALUES ($1, $2)', [1, 'rw-after']);
      expect((await db.query('SELECT name FROM items')).rows).toHaveLength(1);
    });

    it('checks health and exposes pool statistics', async () => {
      const health = await db.checkHealth();
      expect(health.ok).toBe(true);
      expect(typeof health.latencyMs).toBe('number');
      expect(health.details).toMatchObject({
        dialect: factory.dialect,
        pool: { max: expect.any(Number) },
      });
      const stats = db.stats();
      expect(stats.state).toBe('open');
      expect(stats.queries).toBeGreaterThan(0);
      expect(stats.pool.total).toBeGreaterThanOrEqual(1);
    });

    it('drains in-flight work on close and rejects new work', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tx = db.transaction(async (t) => {
        await t.query('INSERT INTO items (id, name) VALUES ($1, $2)', [1, 'draining']);
        await gate;
        await t.query('INSERT INTO items (id, name) VALUES ($1, $2)', [2, 'still-works']);
        return 'done';
      });
      await new Promise((r) => setTimeout(r, 20));
      const closing = db.close();
      await expect(db.query('SELECT 1')).rejects.toMatchObject({ code: 'DB_CLOSED' });
      release();
      await expect(tx).resolves.toBe('done');
      await closing;
      expect(db.stats().state).toBe('closed');
      const health = await db.checkHealth();
      expect(health.ok).toBe(false);
    });
  });
}
