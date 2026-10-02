import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import type { SqlClient, SqlQueryResult } from '../../src/ports.js';

const RETURNS_ROWS = /^\s*(select|with|pragma|values)\b|\breturning\b/i;
const require = createRequire(import.meta.url);

function toSqliteParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return JSON.stringify(value);
  }
  return value;
}

export function createSqliteClient(): SqlClient & { close(): void } {
  const db = new DatabaseSync(':memory:');
  let depth = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const exec = async <Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> => {
    if (
      params.length === 0 &&
      sql
        .trim()
        .replace(/;+\s*$/, '')
        .includes(';')
    ) {
      db.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    const stmt = db.prepare(sql.replace(/\$(\d+)/g, '?$1'));
    const args = params.map(toSqliteParam) as never[];
    if (RETURNS_ROWS.test(sql)) {
      const rows = stmt.all(...args) as Row[];
      return { rows, rowCount: rows.length };
    }
    const result = stmt.run(...args);
    return { rows: [], rowCount: Number(result.changes) };
  };
  const client: SqlClient & { close(): void } = {
    dialect: 'sqlite',
    query: exec,
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      if (depth > 0) {
        const name = `sp_${depth}`;
        db.exec(`SAVEPOINT ${name}`);
        depth++;
        try {
          const out = await fn(client);
          db.exec(`RELEASE ${name}`);
          return out;
        } catch (err) {
          db.exec(`ROLLBACK TO ${name}`);
          db.exec(`RELEASE ${name}`);
          throw err;
        } finally {
          depth--;
        }
      }
      const run = queue.then(async () => {
        db.exec('BEGIN');
        depth = 1;
        try {
          const out = await fn(client);
          db.exec('COMMIT');
          return out;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        } finally {
          depth = 0;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
    close: () => db.close(),
  };
  return client;
}

type PgModule = {
  Client: new (opts: {
    connectionString: string;
  }) => {
    connect(): Promise<void>;
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
    end(): Promise<void>;
  };
  Pool: new (opts: {
    connectionString: string;
    max?: number;
    options?: string;
  }) => {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
    connect(): Promise<{
      query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
      release(): void;
    }>;
    end(): Promise<void>;
  };
};

export function tryLoadPg(): PgModule | undefined {
  try {
    return require('pg') as PgModule;
  } catch {
    try {
      return require('../../../../db/node_modules/pg') as PgModule;
    } catch {
      return undefined;
    }
  }
}

export async function createPostgresClient(
  url: string,
): Promise<SqlClient & { close(): Promise<void> }> {
  const pg = tryLoadPg();
  if (!pg) {
    throw new Error('pg is not installed for @aspec/api tests');
  }
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
  type Q = {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  };
  const wrap = (q: Q, depth: number): SqlClient => ({
    dialect: 'postgres',
    async query<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<SqlQueryResult<Row>> {
      const r = await q.query(sql, params as unknown[]);
      return { rows: r.rows as Row[], rowCount: r.rowCount ?? 0 };
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
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
