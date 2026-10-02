import type { ClientOptions } from '../client.js';
import { type JournalMode, type SqliteConfig, validateDatabaseConfig } from '../config.js';
import type { PoolStats, Row, SqlDriver, SqlDriverConnection } from '../driver.js';
import { DbError, DbErrorCode } from '../errors.js';
import type { SqlQueryResult } from '../ports.js';
import { scanSql } from '../sql-text.js';

export interface SqliteClientOptions extends ClientOptions {
  /** File path or `:memory:`. Either this or `url` is required. */
  filename?: string;
  /** `sqlite:` / `file:` URL or a path. */
  url?: string;
  readonly?: boolean;
  /** Busy timeout in milliseconds. Default 5000. */
  busyTimeoutMs?: number;
  /** Journal mode. Default `wal` for writable files. */
  journalMode?: JournalMode;
  /** `PRAGMA foreign_keys`. Default true. */
  foreignKeys?: boolean;
  /** Return INTEGER columns as `bigint` instead of `number`. Default false. */
  safeIntegers?: boolean;
}

export function resolveSqliteConfig(
  options: SqliteClientOptions,
  driver: SqliteConfig['driver'],
): SqliteConfig {
  const input: Record<string, unknown> = { dialect: 'sqlite', driver };
  for (const key of [
    'url',
    'filename',
    'readonly',
    'busyTimeoutMs',
    'journalMode',
    'foreignKeys',
  ] as const) {
    if (options[key] !== undefined) input[key] = options[key];
  }
  return validateDatabaseConfig(input) as SqliteConfig;
}

/**
 * Converts a JavaScript value to a SQLite binding: `undefined` becomes NULL, booleans 1/0,
 * Dates epoch milliseconds, plain objects and arrays JSON text. Strings, numbers, bigints,
 * null and binary data (Uint8Array/Buffer) pass through.
 */
export function normaliseSqliteParam(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value ? 1 : 0;
    case 'string':
    case 'number':
    case 'bigint':
      return value;
    case 'object':
      if (value instanceof Date) return value.getTime();
      if (value instanceof Uint8Array) return value;
      if (ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return JSON.stringify(value);
    default:
      throw new DbError(
        DbErrorCode.PARAMETER_MISMATCH,
        `Unsupported SQLite parameter type: ${typeof value}`,
      );
  }
}

export type PreparedSqlite =
  | { mode: 'exec'; sql: string }
  | { mode: 'statement'; sql: string; args: unknown[] };

/**
 * Applies the SqlClient rules to SQLite: `$n` placeholders become positional `?` bindings
 * (reused numbers are expanded, so `$1 ... $1` binds the first value twice), parameterless
 * scripts with several statements run through `exec`, and a parameterised query with more
 * than one statement is rejected.
 */
export function prepareSqlite(sql: string, params: readonly unknown[]): PreparedSqlite {
  const scanned = scanSql(sql, 'sqlite');
  if (scanned.statements.length > 1 || scanned.statements.length === 0) {
    if (params.length > 0) {
      throw new DbError(
        DbErrorCode.MULTI_STATEMENT,
        'A query with parameters must contain exactly one statement',
        { status: 500 },
      );
    }
    return { mode: 'exec', sql };
  }
  let max = 0;
  for (const index of scanned.placeholders) {
    if (index < 1) {
      throw new DbError(DbErrorCode.PARAMETER_MISMATCH, 'Placeholders start at $1');
    }
    if (index > max) max = index;
  }
  if (max !== params.length) {
    throw new DbError(
      DbErrorCode.PARAMETER_MISMATCH,
      `Query references ${max} parameter(s) but ${params.length} were supplied`,
    );
  }
  const args = scanned.placeholders.map((i) => normaliseSqliteParam(params[i - 1]));
  return { mode: 'statement', sql: scanned.sql, args };
}

export const RETURNS_ROWS =
  /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(select|with|pragma|values|explain)\b|\breturning\b/i;

/** SQLITE_BUSY (5) and SQLITE_LOCKED (6), including extended result codes. */
export function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const e = error as { code?: unknown; errcode?: unknown; message?: unknown };
  if (typeof e.code === 'string' && /^SQLITE_(BUSY|LOCKED)/.test(e.code)) return true;
  if (typeof e.errcode === 'number' && ((e.errcode & 0xff) === 5 || (e.errcode & 0xff) === 6))
    return true;
  return false;
}

export interface SyncSqliteEngine {
  run(sql: string, params: readonly unknown[]): SqlQueryResult<Row>;
  close(): void;
}

/** Pragmas applied to every new SQLite connection. */
export function connectionPragmas(config: SqliteConfig): string[] {
  const pragmas = [`PRAGMA busy_timeout = ${config.busyTimeoutMs}`];
  pragmas.push(`PRAGMA foreign_keys = ${config.foreignKeys ? 'ON' : 'OFF'}`);
  if (config.journalMode && !config.readonly)
    pragmas.push(`PRAGMA journal_mode = ${config.journalMode.toUpperCase()}`);
  if (config.readonly) pragmas.push('PRAGMA query_only = ON');
  return pragmas;
}

/**
 * SQLite drivers keep one connection. Callers are queued so a transaction owns the
 * connection until it finishes and statements from other async flows cannot interleave.
 */
export function createSingleConnectionDriver(
  name: string,
  openEngine: () => Promise<SyncSqliteEngine>,
): SqlDriver {
  let engine: SyncSqliteEngine | undefined;
  let busy = false;
  const waiters: Array<() => void> = [];

  const lock = (): Promise<void> => {
    if (!busy) {
      busy = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
  };
  const unlock = (): void => {
    const next = waiters.shift();
    if (next) next();
    else busy = false;
  };

  const exec = (sql: string, params: readonly unknown[]): Promise<SqlQueryResult<Row>> => {
    if (!engine)
      return Promise.reject(new DbError(DbErrorCode.CLOSED, 'SQLite database is not open'));
    try {
      return Promise.resolve(engine.run(sql, params));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  return {
    dialect: 'sqlite',
    name,
    async open() {
      if (!engine) engine = await openEngine();
    },
    async query(sql, params) {
      await lock();
      try {
        return await exec(sql, params);
      } finally {
        unlock();
      }
    },
    async acquire(): Promise<SqlDriverConnection> {
      await lock();
      let released = false;
      return {
        query: (sql, params) =>
          released
            ? Promise.reject(new DbError(DbErrorCode.CLOSED, 'Connection already released'))
            : exec(sql, params),
        release() {
          if (released) return;
          released = true;
          unlock();
        },
      };
    },
    stats(): PoolStats {
      return {
        total: engine ? 1 : 0,
        idle: engine && !busy ? 1 : 0,
        waiting: waiters.length,
        max: 1,
      };
    },
    async close() {
      const current = engine;
      engine = undefined;
      current?.close();
    },
  };
}

/** Small LRU of prepared statements keyed by SQL text. */
export class StatementCache<S> {
  readonly #max: number;
  readonly #map = new Map<string, S>();

  constructor(max = 200) {
    this.#max = max;
  }

  get(sql: string, create: () => S): S {
    const hit = this.#map.get(sql);
    if (hit !== undefined) {
      this.#map.delete(sql);
      this.#map.set(sql, hit);
      return hit;
    }
    const stmt = create();
    this.#map.set(sql, stmt);
    if (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    return stmt;
  }

  clear(): void {
    this.#map.clear();
  }
}
