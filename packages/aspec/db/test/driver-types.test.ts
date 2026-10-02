import BetterSqlite3 from 'better-sqlite3';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { BetterSqlite3Constructor } from '../src/drivers/better-sqlite3.js';
import type { PgModule, PgPool } from '../src/drivers/postgres.js';

// The drivers describe `pg` and `better-sqlite3` structurally so the module compiles without
// them. These assignments fail `npm run typecheck` if the real packages stop matching.
describe('optional driver types', () => {
  it('accept the real pg and better-sqlite3 exports', async () => {
    const pgModule: PgModule = pg;
    const pool: PgPool = new pgModule.Pool({ max: 1 });
    const Ctor: BetterSqlite3Constructor = BetterSqlite3;
    const db = new Ctor(':memory:');
    const stmt = db.prepare('SELECT 1 AS one');
    expect(stmt.reader).toBe(true);
    expect(stmt.all()).toEqual([{ one: 1 }]);
    db.close();
    expect(pool.totalCount).toBe(0);
    await pool.end();
  });
});
