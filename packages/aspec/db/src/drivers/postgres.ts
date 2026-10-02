import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import { type ClientOptions, createClientFromDriver, type Database } from '../client.js';
import {
  type DatabaseConfigInput,
  type PemInput,
  type PostgresConfig,
  type SslConfig,
  validateDatabaseConfig,
} from '../config.js';
import type { PoolStats, Row, SqlDriver, SqlDriverConnection } from '../driver.js';
import { DbError, DbErrorCode } from '../errors.js';
import { importOptional } from '../optional-import.js';
import type { SqlQueryResult } from '../ports.js';
import { safeErrorMessage } from '../redact.js';

// Structural subsets of the `pg` types used here. `pg` is an optional peer dependency, so
// this module must compile without `pg` or `@types/pg` installed; a real `pg.Pool` and the
// `pg` module satisfy these interfaces.

/** Result of `Pool#query` and `PoolClient#query`. */
export interface PgQueryResult {
  rows?: unknown[];
  rowCount?: number | null;
}

/** A client checked out from a `pg.Pool`. */
export interface PgPoolClient {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult | PgQueryResult[]>;
  release(destroy?: boolean | Error): void;
}

/** The part of `pg.Pool` used here. */
export interface PgPool {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult | PgQueryResult[]>;
  connect(): Promise<PgPoolClient>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  end(): Promise<void>;
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

/** The `pg.PoolConfig` fields set by `buildPgPoolConfig`. */
export interface PgPoolConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  maxLifetimeSeconds?: number;
  ssl?: false | ConnectionOptions;
  statement_timeout?: number;
  application_name?: string;
  options?: string;
}

/** The part of the `pg` module used here (`import pg from 'pg'`). */
export interface PgModule {
  Pool: new (config?: PgPoolConfig) => PgPool;
}

export interface PostgresClientOptions
  extends Omit<
      DatabaseConfigInput,
      | 'dialect'
      | 'filename'
      | 'readonly'
      | 'driver'
      | 'busyTimeoutMs'
      | 'journalMode'
      | 'foreignKeys'
    >,
    ClientOptions {
  /** The `pg` module. Loaded with a dynamic import when omitted. */
  pg?: PgModule;
}

export interface FromPgPoolOptions extends ClientOptions {
  /** End the pool on `close()`. Default false: the caller owns the pool. */
  ownsPool?: boolean;
}

function toBuffer(value: string | Uint8Array): string | Buffer {
  return typeof value === 'string' ? value : Buffer.from(value);
}

function pemList(value: PemInput): Array<string | Buffer> {
  if (typeof value === 'string' || value instanceof Uint8Array) return [toBuffer(value)];
  return value.map(toBuffer);
}

function readPem(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new DbError(
      DbErrorCode.CONFIG_INVALID,
      `Cannot read ${what} file: ${safeErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Maps an SSL mode to `tls.connect` options for `pg`, following libpq semantics:
 * `require` encrypts without verifying the certificate, `verify-ca` verifies the chain but
 * not the hostname, `verify-full` verifies both.
 */
export function buildPgSslOptions(ssl: SslConfig): false | ConnectionOptions {
  if (ssl.mode === 'disable') return false;
  const options: ConnectionOptions = {};
  const ca: Array<string | Buffer> = [];
  if (ssl.ca !== undefined) ca.push(...pemList(ssl.ca));
  if (ssl.caFile !== undefined) ca.push(readPem(ssl.caFile, 'SSL CA'));
  if (ca.length > 0) options.ca = ca;
  if (ssl.cert !== undefined) options.cert = toBuffer(ssl.cert);
  if (ssl.certFile !== undefined) options.cert = readPem(ssl.certFile, 'SSL client certificate');
  if (ssl.key !== undefined) options.key = toBuffer(ssl.key);
  if (ssl.keyFile !== undefined) options.key = readPem(ssl.keyFile, 'SSL client key');
  if (ssl.servername !== undefined) options.servername = ssl.servername;
  switch (ssl.mode) {
    case 'require':
      options.rejectUnauthorized = false;
      break;
    case 'verify-ca':
      options.rejectUnauthorized = true;
      options.checkServerIdentity = () => undefined;
      break;
    case 'verify-full':
      options.rejectUnauthorized = true;
      break;
  }
  return options;
}

/** Translates validated configuration into a `pg.Pool` configuration. */
export function buildPgPoolConfig(config: PostgresConfig): PgPoolConfig {
  const pool: PgPoolConfig = {
    host: config.host,
    port: config.port,
    max: config.pool.max,
    idleTimeoutMillis: config.pool.idleTimeoutMs,
    connectionTimeoutMillis: config.pool.connectionTimeoutMs,
    ssl: buildPgSslOptions(config.ssl),
  };
  if (config.pool.maxLifetimeSeconds > 0) pool.maxLifetimeSeconds = config.pool.maxLifetimeSeconds;
  if (config.user !== undefined) pool.user = config.user;
  if (config.password !== undefined) pool.password = config.password;
  if (config.database !== undefined) pool.database = config.database;
  if (config.statementTimeoutMs !== undefined) pool.statement_timeout = config.statementTimeoutMs;
  if (config.applicationName !== undefined) pool.application_name = config.applicationName;
  if (config.searchPath !== undefined)
    pool.options = `-c search_path=${config.searchPath.join(',')}`;
  return pool;
}

function normaliseParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function normaliseParams(params: readonly unknown[]): unknown[] | undefined {
  return params.length === 0 ? undefined : params.map(normaliseParam);
}

function toResult(result: PgQueryResult | PgQueryResult[]): SqlQueryResult<Row> {
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  if (!last) return { rows: [], rowCount: 0 };
  const rows = (last.rows ?? []) as Row[];
  return { rows, rowCount: last.rowCount ?? rows.length };
}

async function loadPg(): Promise<PgModule> {
  try {
    const mod = (await importOptional('pg')) as { default?: PgModule } & Partial<PgModule>;
    return (mod.default ?? mod) as PgModule;
  } catch (error) {
    throw new DbError(
      DbErrorCode.DRIVER_MISSING,
      'The pg package is not installed. Install it with: npm install pg',
      { cause: error },
    );
  }
}

interface PgDriverSource {
  pool: () => Promise<PgPool>;
  existing?: PgPool;
  ownsPool: boolean;
  max: number;
  secrets: string[];
}

function createPgDriver(source: PgDriverSource, options: ClientOptions): SqlDriver {
  let pool: PgPool | undefined = source.existing;
  let creating: Promise<PgPool> | undefined;
  let verified = false;
  const onError = (error: Error): void => {
    options.logger?.error(
      { err: safeErrorMessage(error, source.secrets) },
      'idle PostgreSQL client error',
    );
  };
  if (pool) pool.on('error', onError);

  const getPool = async (): Promise<PgPool> => {
    if (pool) return pool;
    if (!creating) {
      creating = source.pool().then((p) => {
        p.on('error', onError);
        pool = p;
        return p;
      });
      creating.catch(() => {
        creating = undefined;
      });
    }
    return creating;
  };

  return {
    dialect: 'postgres',
    name: 'pg',
    secrets: source.secrets,
    async open() {
      const p = await getPool();
      if (verified) return;
      const client = await p.connect();
      try {
        await client.query('SELECT 1');
        verified = true;
      } finally {
        client.release();
      }
    },
    async query(sql, params) {
      const p = await getPool();
      return toResult(await p.query(sql, normaliseParams(params)));
    },
    async acquire(): Promise<SqlDriverConnection> {
      const p = await getPool();
      const client: PgPoolClient = await p.connect();
      let released = false;
      return {
        async query(sql, params) {
          if (released) throw new DbError(DbErrorCode.CLOSED, 'Connection already released');
          return toResult(await client.query(sql, normaliseParams(params)));
        },
        release(destroy) {
          if (released) return;
          released = true;
          client.release(destroy ? true : undefined);
        },
      };
    },
    stats(): PoolStats {
      if (!pool) return { total: 0, idle: 0, waiting: 0, max: source.max };
      return {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max: source.max,
      };
    },
    async close() {
      const p = pool ?? (creating ? await creating.catch(() => undefined) : undefined);
      if (!p) return;
      p.off('error', onError);
      if (source.ownsPool) await p.end();
    },
  };
}

/**
 * PostgreSQL client backed by a `pg.Pool` created from configuration (URL or fields). The
 * pool is created lazily on first use; call `connect()` to connect eagerly with retries.
 */
export function createPostgresClient(options: PostgresClientOptions): Database {
  const input: Record<string, unknown> = { dialect: 'postgres' };
  for (const key of [
    'url',
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
  ] as const) {
    if (options[key] !== undefined) input[key] = options[key];
  }
  const config = validateDatabaseConfig(input) as PostgresConfig;
  const poolConfig = buildPgPoolConfig(config);
  const driver = createPgDriver(
    {
      pool: async () => {
        const pg = options.pg ?? (await loadPg());
        return new pg.Pool(poolConfig);
      },
      ownsPool: true,
      max: config.pool.max,
      secrets: config.password ? [config.password] : [],
    },
    options,
  );
  for (const warning of config.warnings)
    options.logger?.warn({ warning }, 'database configuration warning');
  return createClientFromDriver(driver, options);
}

/**
 * Adapts an existing `pg.Pool` to the SqlClient port with transactions, savepoints,
 * instrumentation and health checks. `close()` leaves the pool open unless `ownsPool`.
 */
export function fromPgPool(pool: PgPool, options: FromPgPoolOptions = {}): Database {
  const poolOptions = (pool as unknown as { options?: { max?: number; password?: unknown } })
    .options;
  const password = typeof poolOptions?.password === 'string' ? poolOptions.password : undefined;
  const driver = createPgDriver(
    {
      pool: async () => pool,
      existing: pool,
      ownsPool: options.ownsPool ?? false,
      max: poolOptions?.max ?? 10,
      secrets: password ? [password] : [],
    },
    options,
  );
  return createClientFromDriver(driver, options);
}
