import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createClientFromDriver, type Database } from '../client.js';
import type { Row } from '../driver.js';
import {
  connectionPragmas,
  createSingleConnectionDriver,
  prepareSqlite,
  RETURNS_ROWS,
  resolveSqliteConfig,
  type SqliteClientOptions,
  StatementCache,
  type SyncSqliteEngine,
} from './sqlite-common.js';

export type NodeSqliteClientOptions = SqliteClientOptions;

interface StatementExtras {
  columns?: () => unknown[];
  setReadBigInts?: (enabled: boolean) => void;
}

function plain(row: unknown): Row {
  return Object.getPrototypeOf(row) === null ? { ...(row as Row) } : (row as Row);
}

/**
 * SQLite client backed by the built-in `node:sqlite` module (no native dependency). Same
 * semantics as `createSqliteClient`. `node:sqlite` is marked experimental by Node.js and
 * prints an ExperimentalWarning on first use.
 */
export function createNodeSqliteClient(options: NodeSqliteClientOptions): Database {
  const config = resolveSqliteConfig(options, 'node:sqlite');
  const driver = createSingleConnectionDriver('node:sqlite', async () => {
    const db = new DatabaseSync(config.filename);
    try {
      for (const pragma of connectionPragmas(config)) db.exec(pragma);
    } catch (error) {
      db.close();
      throw error;
    }
    const cache = new StatementCache<StatementSync & StatementExtras>();
    const engine: SyncSqliteEngine = {
      run(sql, params) {
        const prepared = prepareSqlite(sql, params);
        if (prepared.mode === 'exec') {
          db.exec(prepared.sql);
          return { rows: [], rowCount: 0 };
        }
        const stmt = cache.get(prepared.sql, () => {
          const created = db.prepare(prepared.sql) as StatementSync & StatementExtras;
          if (options.safeIntegers) created.setReadBigInts?.(true);
          return created;
        });
        const args = prepared.args as never[];
        const returnsRows =
          typeof stmt.columns === 'function'
            ? stmt.columns().length > 0
            : RETURNS_ROWS.test(prepared.sql);
        if (returnsRows) {
          const rows = stmt.all(...args).map(plain);
          return { rows, rowCount: rows.length };
        }
        const info = stmt.run(...args);
        return { rows: [], rowCount: Number(info.changes) };
      },
      close() {
        cache.clear();
        db.close();
      },
    };
    return engine;
  });
  const db = createClientFromDriver(driver, options);
  for (const warning of config.warnings)
    options.logger?.warn({ warning }, 'database configuration warning');
  return db;
}
