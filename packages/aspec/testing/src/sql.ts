import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { registerCleanup } from './cleanup.js';
import { invalidOption, TestingError, TestingErrorCode } from './errors.js';
import type { SqlClient, SqlDialect, SqlQueryResult } from './ports.js';

const RETURNS_ROWS = /^\s*(select|with|pragma|values)\b|\breturning\b/i;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdent(name: string, option: string): string {
  if (!IDENT.test(name) || name.length > 63) {
    throw new TestingError(
      TestingErrorCode.SQL_INVALID_IDENTIFIER,
      `Invalid SQL identifier for "${option}": "${name}" (use letters, digits and underscores, max 63)`,
    );
  }
  return name;
}

function toSqliteParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return JSON.stringify(value);
  }
  return value;
}

function assertSingleStatement(sql: string, params: readonly unknown[]): void {
  if (params.length === 0) return;
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (trimmed.includes(';')) {
    throw new TestingError(
      TestingErrorCode.SQL_MULTI_STATEMENT,
      'A query with parameters must contain exactly one statement',
    );
  }
}

export interface ClosableSqlClient extends SqlClient {
  close(): void | Promise<void>;
}

/** In-memory SQLite SqlClient over `node:sqlite` with $n placeholders and the multi-statement rule. */
export function createSqliteClient(): ClosableSqlClient {
  const db = new DatabaseSync(':memory:');
  let depth = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const exec = async <Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> => {
    assertSingleStatement(sql, params);
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
  const client: ClosableSqlClient = {
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

interface PgLike {
  Client: new (config: {
    connectionString: string;
  }) => {
    connect(): Promise<void>;
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
    end(): Promise<void>;
  };
  Pool: new (config: {
    connectionString: string;
    max?: number;
    options?: string;
  }) => {
    connect(): Promise<{
      query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
      release(): void;
    }>;
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
    end(): Promise<void>;
  };
}

async function loadPg(pgModule?: PgLike): Promise<PgLike> {
  if (pgModule) return pgModule;
  try {
    // A non-literal specifier keeps this module compilable without pg or @types/pg installed.
    const specifier: string = 'pg';
    const mod = (await import(specifier)) as { default?: PgLike } & PgLike;
    return mod.default ?? mod;
  } catch (err) {
    throw new TestingError(
      TestingErrorCode.POSTGRES_DRIVER_MISSING,
      'PostgreSQL fixtures require the optional peer dependency "pg". Install it in the consuming project.',
      { cause: err, expose: true },
    );
  }
}

export interface PostgresClientOptions {
  /** Connection string. Default: process.env.ASPEC_TEST_POSTGRES_URL. */
  url?: string;
  /** Schema name. Default: a random `test_<hex>` schema that is dropped on close. */
  schema?: string;
  /** When true (default), create the schema on open and drop it on close. */
  manageSchema?: boolean;
  /** The `pg` module. Loaded dynamically when omitted. */
  pg?: PgLike;
}

export interface PostgresTestClient extends ClosableSqlClient {
  readonly schema: string;
  close(): Promise<void>;
}

/** PostgreSQL SqlClient isolated in its own schema (created and dropped by default). */
export async function createPostgresClient(
  options: PostgresClientOptions = {},
): Promise<PostgresTestClient> {
  const url = options.url ?? process.env.ASPEC_TEST_POSTGRES_URL;
  if (!url) throw invalidOption('url', 'pass a connection string or set ASPEC_TEST_POSTGRES_URL');
  const pg = await loadPg(options.pg);
  const manage = options.manageSchema ?? true;
  const schema = assertIdent(options.schema ?? `test_${randomBytes(6).toString('hex')}`, 'schema');
  if (manage) {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
    } finally {
      await admin.end();
    }
  }
  const pool = new pg.Pool({ connectionString: url, max: 5, options: `-c search_path=${schema}` });
  const wrap = (
    q: {
      query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
    },
    depth: number,
  ): SqlClient => ({
    dialect: 'postgres',
    async query<Row>(sql: string, params: readonly unknown[] = []) {
      assertSingleStatement(sql, params);
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
  const base = wrap(pool, 0);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    unregister();
    await pool.end();
    if (manage) {
      const cleanup = new pg.Client({ connectionString: url });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await cleanup.end();
      }
    }
  };
  const unregister = registerCleanup(close);
  return Object.assign(base, { schema, close });
}

export interface Migration {
  id: string;
  postgres: string;
  sqlite: string;
}

export interface MigrateOptions {
  /** Migrations table name. Default testing_schema_migrations. */
  table?: string;
}

/** Applies pending migrations idempotently using a schema_migrations table. */
export async function migrate(
  client: SqlClient,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): Promise<string[]> {
  const table = assertIdent(options.table ?? 'testing_schema_migrations', 'table');
  if (client.dialect === 'postgres') {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`,
    );
  } else {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
    );
  }
  const applied = new Set(
    (await client.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)).rows.map(
      (r) => r.id,
    ),
  );
  const ran: string[] = [];
  for (const m of migrations) {
    if (!m.id || m.id.length > 128 || /[^\w.-]/.test(m.id)) {
      throw invalidOption('migrations', `migration id "${m.id}" is invalid`);
    }
    if (applied.has(m.id)) continue;
    const sql = client.dialect === 'postgres' ? m.postgres : m.sqlite;
    await client.transaction(async (tx) => {
      await tx.query(sql);
      await tx.query(`INSERT INTO ${table} (id, applied_at) VALUES ($1, $2)`, [m.id, Date.now()]);
    });
    ran.push(m.id);
  }
  return ran;
}

export interface TruncateOptions {
  /** Restart identity columns (PostgreSQL only). Default true. */
  restartIdentity?: boolean;
  /** Cascade to dependent tables (PostgreSQL only). Default true. */
  cascade?: boolean;
}

/** Truncates the listed tables. Table names must be validated identifiers. */
export async function truncateTables(
  client: SqlClient,
  tables: readonly string[],
  options: TruncateOptions = {},
): Promise<void> {
  if (tables.length === 0) return;
  const names = tables.map((t) => assertIdent(t, 'tables'));
  if (client.dialect === 'postgres') {
    const restart = options.restartIdentity === false ? '' : ' RESTART IDENTITY';
    const cascade = options.cascade === false ? '' : ' CASCADE';
    await client.query(`TRUNCATE ${names.join(', ')}${restart}${cascade}`);
    return;
  }
  await client.transaction(async (tx) => {
    for (const name of names) {
      await tx.query(`DELETE FROM ${name}`);
    }
  });
}

class RollbackSentinel extends Error {
  constructor() {
    super('aspec-testing-rollback');
    this.name = 'RollbackSentinel';
  }
}

/**
 * Runs `fn` inside a transaction that is always rolled back. Nested work that commits through
 * the same client still participates in the outer transaction (savepoints), so the fixture
 * isolates writes from the rest of the suite.
 */
export async function withTransactionRollback<T>(
  client: SqlClient,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  let result!: T;
  try {
    await client.transaction(async (tx) => {
      result = await fn(tx);
      throw new RollbackSentinel();
    });
  } catch (err) {
    if (err instanceof RollbackSentinel) return result;
    throw err;
  }
  return result;
}

/** Alias for withTransactionRollback. */
export const withRollback = withTransactionRollback;

export interface SqlFixtureOptions {
  dialect?: SqlDialect;
  postgres?: PostgresClientOptions;
  migrations?: readonly Migration[];
  migrateOptions?: MigrateOptions;
}

export interface SqlFixture extends ClosableSqlClient {
  readonly managed: boolean;
}

/** Creates a SQLite or PostgreSQL client, optionally runs migrations, and registers cleanup. */
export async function createSqlFixture(options: SqlFixtureOptions = {}): Promise<SqlFixture> {
  const dialect =
    options.dialect ??
    (options.postgres || process.env.ASPEC_TEST_POSTGRES_URL ? 'postgres' : 'sqlite');
  if (dialect === 'sqlite') {
    const client = createSqliteClient();
    const unregister = registerCleanup(() => client.close());
    if (options.migrations) await migrate(client, options.migrations, options.migrateOptions);
    const close = (): void => {
      unregister();
      client.close();
    };
    return Object.assign(client, { managed: true, close });
  }
  const client = await createPostgresClient(options.postgres);
  if (options.migrations) await migrate(client, options.migrations, options.migrateOptions);
  return Object.assign(client, { managed: true });
}
