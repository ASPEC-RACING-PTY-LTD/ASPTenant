import { createClientFromDriver, type Database } from '../client.js';
import type { Row } from '../driver.js';
import { DbError, DbErrorCode } from '../errors.js';
import { importOptional } from '../optional-import.js';
import {
  connectionPragmas,
  createSingleConnectionDriver,
  prepareSqlite,
  resolveSqliteConfig,
  type SqliteClientOptions,
  StatementCache,
  type SyncSqliteEngine,
} from './sqlite-common.js';

export type { SqliteClientOptions } from './sqlite-common.js';

// Structural subsets of the `better-sqlite3` types used here. The package is an optional
// peer dependency, so this module must compile without it or `@types/better-sqlite3`; the
// real `Database` constructor satisfies these interfaces.

/** A prepared `better-sqlite3` statement. */
export interface BetterSqlite3Statement {
  readonly reader: boolean;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint };
}

/** The part of a `better-sqlite3` database used here. */
export interface BetterSqlite3Database {
  exec(sql: string): unknown;
  prepare(sql: string): BetterSqlite3Statement;
  defaultSafeIntegers(toggle?: boolean): unknown;
  close(): unknown;
}

/** The `better-sqlite3` default export (`import Database from 'better-sqlite3'`). */
export type BetterSqlite3Constructor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => BetterSqlite3Database;

export interface BetterSqliteClientOptions extends SqliteClientOptions {
  /** The `better-sqlite3` constructor. Loaded with a dynamic import when omitted. */
  driver?: BetterSqlite3Constructor;
}

async function loadBetterSqlite3(): Promise<BetterSqlite3Constructor> {
  try {
    const mod = (await importOptional('better-sqlite3')) as {
      default?: BetterSqlite3Constructor;
    };
    return (mod.default ?? mod) as BetterSqlite3Constructor;
  } catch (error) {
    throw new DbError(
      DbErrorCode.DRIVER_MISSING,
      'The better-sqlite3 package is not installed. Install it (npm install better-sqlite3) or use createNodeSqliteClient.',
      { cause: error },
    );
  }
}

/**
 * SQLite client backed by `better-sqlite3` (optional peer dependency). One connection, a
 * queue that serialises transactions, WAL and a busy timeout for files by default.
 */
export function createSqliteClient(options: BetterSqliteClientOptions): Database {
  const config = resolveSqliteConfig(options, 'better-sqlite3');
  const driver = createSingleConnectionDriver('better-sqlite3', async () => {
    const Ctor = options.driver ?? (await loadBetterSqlite3());
    const db = new Ctor(config.filename, {
      readonly: config.readonly,
      fileMustExist: config.readonly,
      timeout: config.busyTimeoutMs,
    });
    try {
      for (const pragma of connectionPragmas(config)) db.exec(pragma);
      if (options.safeIntegers) db.defaultSafeIntegers(true);
    } catch (error) {
      db.close();
      throw error;
    }
    const cache = new StatementCache<BetterSqlite3Statement>();
    const engine: SyncSqliteEngine = {
      run(sql, params) {
        const prepared = prepareSqlite(sql, params);
        if (prepared.mode === 'exec') {
          db.exec(prepared.sql);
          return { rows: [], rowCount: 0 };
        }
        const stmt = cache.get(prepared.sql, () => db.prepare(prepared.sql));
        if (stmt.reader) {
          const rows = stmt.all(...prepared.args) as Row[];
          return { rows, rowCount: rows.length };
        }
        const info = stmt.run(...prepared.args);
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
