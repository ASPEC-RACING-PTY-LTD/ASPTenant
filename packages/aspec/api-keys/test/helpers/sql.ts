import { DatabaseSync } from 'node:sqlite';
import type { SqlClient, SqlQueryResult } from '../../src/ports.js';

const RETURNS_ROWS = /^\s*(select|with|pragma|values)\b|\breturning\b/i;

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
