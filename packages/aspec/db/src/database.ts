import type { ClientOptions, Database } from './client.js';
import { type DatabaseConfigInput, validateDatabaseConfig } from './config.js';
import { DbError, DbErrorCode } from './errors.js';
import { importOptional } from './optional-import.js';

export interface CreateDatabaseOptions extends DatabaseConfigInput, ClientOptions {
  /** Skip the eager `connect()` (with retries). The first query connects instead. Default false. */
  lazy?: boolean;
  /** SQLite only: return INTEGER columns as bigint. */
  safeIntegers?: boolean;
}

/**
 * Creates a client for PostgreSQL or SQLite from a URL or configuration, loading the
 * matching driver on demand: `pg` for PostgreSQL; for SQLite, `better-sqlite3` when
 * installed (or requested with `driver`), otherwise the built-in `node:sqlite`.
 */
export async function createDatabase(options: CreateDatabaseOptions): Promise<Database> {
  const config = validateDatabaseConfig(pickConfig(options));
  let db: Database;
  if (config.dialect === 'postgres') {
    const { createPostgresClient } = await import('./drivers/postgres.js');
    db = createPostgresClient(options);
  } else {
    const { lazy: _lazy, driver: requested, ...rest } = options;
    let useBetter = requested === 'better-sqlite3';
    if (requested === undefined) {
      try {
        await importOptional('better-sqlite3');
        useBetter = true;
      } catch {
        useBetter = false;
      }
    }
    if (useBetter) {
      const { createSqliteClient } = await import('./drivers/better-sqlite3.js');
      db = createSqliteClient(rest);
    } else {
      const { createNodeSqliteClient } = await import('./drivers/node-sqlite.js');
      db = createNodeSqliteClient(rest);
    }
  }
  if (!options.lazy) {
    try {
      await db.connect();
    } catch (error) {
      await db.close().catch(() => undefined);
      throw error instanceof DbError
        ? error
        : new DbError(DbErrorCode.CONNECTION_FAILED, 'Could not connect', { cause: error });
    }
  }
  return db;
}

const CONFIG_KEYS = [
  'url',
  'dialect',
  'host',
  'port',
  'user',
  'password',
  'database',
  'ssl',
  'pool',
  'statementTimeoutMs',
  'applicationName',
  'searchPath',
  'filename',
  'readonly',
  'driver',
  'busyTimeoutMs',
  'journalMode',
  'foreignKeys',
] as const;

function pickConfig(options: CreateDatabaseOptions): DatabaseConfigInput {
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) if (options[key] !== undefined) out[key] = options[key];
  return out as DatabaseConfigInput;
}
