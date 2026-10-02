import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { SqlClient } from '../../src/ports.js';

export async function createPostgresClient(
  url: string,
): Promise<SqlClient & { close(): Promise<void> }> {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    options: `-c search_path=${schema}`,
  });
  const wrap = (q: pg.Pool | pg.PoolClient, depth: number): SqlClient => ({
    dialect: 'postgres',
    async query(sql, params = []) {
      const r = await q.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async transaction(fn) {
      if (depth > 0) {
        const sp = `sp_${depth}`;
        await q.query(`SAVEPOINT ${sp}`);
        try {
          const out = await fn(wrap(q, depth + 1));
          await q.query(`RELEASE SAVEPOINT ${sp}`);
          return out;
        } catch (err) {
          await q.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          throw err;
        }
      }
      const conn = await pool.connect();
      try {
        await conn.query('BEGIN');
        const out = await fn(wrap(conn, 1));
        await conn.query('COMMIT');
        return out;
      } catch (err) {
        await conn.query('ROLLBACK');
        throw err;
      } finally {
        conn.release();
      }
    },
  });
  const client = wrap(pool, 0);
  return Object.assign(client, {
    async close() {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: url });
      await cleanup.connect();
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await cleanup.end();
    },
  });
}
