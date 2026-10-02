import { AsyncLocalStorage } from 'node:async_hooks';
import { randomInt } from 'node:crypto';
import type { PoolStats, Row, SqlDriver, SqlDriverConnection } from './driver.js';
import { DbError, DbErrorCode } from './errors.js';
import { createInstrumenter, type InstrumentationOptions, noopLogger } from './instrumentation.js';
import type { HealthCheckResult, SqlClient, SqlDialect, SqlQueryResult } from './ports.js';
import { errorCode, safeErrorMessage } from './redact.js';

export type IsolationLevel =
  | 'read uncommitted'
  | 'read committed'
  | 'repeatable read'
  | 'serializable';

export interface TransactionOptions {
  /** PostgreSQL isolation level. SQLite transactions are always serializable. */
  isolationLevel?: IsolationLevel;
  /** Read-only transaction (`READ ONLY` in PostgreSQL, `PRAGMA query_only` in SQLite). */
  readOnly?: boolean;
  /**
   * SQLite locking behaviour. Default `immediate` for read-write transactions (takes the
   * write lock up front, so the busy timeout applies) and `deferred` for read-only ones.
   */
  sqliteBehavior?: 'deferred' | 'immediate' | 'exclusive';
}

export interface ConnectRetryOptions {
  /** Additional attempts after the first failure. Default 3. */
  retries?: number;
  /** First backoff delay. Default 200 ms. Doubles per attempt with jitter. */
  minDelayMs?: number;
  /** Upper bound for a backoff delay. Default 5000 ms. */
  maxDelayMs?: number;
}

export interface ClientOptions extends InstrumentationOptions {
  connectRetry?: ConnectRetryOptions;
  /** Timeout for `checkHealth()`. Default 2000 ms. */
  healthTimeoutMs?: number;
  /** Maximum time `close()` waits for in-flight work. Default 10000 ms. */
  closeTimeoutMs?: number;
}

export interface DatabaseStats {
  dialect: SqlDialect;
  driver: string;
  state: 'idle' | 'open' | 'closing' | 'closed';
  pool: PoolStats;
  queries: number;
  errors: number;
  slowQueries: number;
  inFlight: number;
}

/** A SqlClient bound to one connection (see `Database.connection`). */
export interface SessionClient extends SqlClient {
  transaction<T>(fn: (tx: SqlClient) => Promise<T>, options?: TransactionOptions): Promise<T>;
}

/** The client returned by every @aspec/db factory. Satisfies `SqlClient` and `HealthCheckable`. */
export interface Database extends SqlClient {
  readonly dialect: SqlDialect;
  readonly driverName: string;
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SqlQueryResult<R>>;
  /**
   * Runs fn in a transaction on a dedicated connection. Nested calls (on `tx` or on this
   * client from inside fn) use savepoints. Queries on this client from inside fn join the
   * transaction, so accidentally using the outer client never deadlocks or escapes it.
   */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** Runs fn with a dedicated connection (session state such as advisory locks). */
  connection<T>(fn: (conn: SessionClient) => Promise<T>): Promise<T>;
  /** Opens the driver and verifies connectivity, retrying with backoff. Idempotent. */
  connect(): Promise<void>;
  /** Rejects new work, waits for in-flight queries and transactions, then closes the driver. */
  close(options?: { timeoutMs?: number }): Promise<void>;
  stats(): DatabaseStats;
  /** `SELECT 1` with a timeout. Never throws. */
  checkHealth(options?: { timeoutMs?: number }): Promise<HealthCheckResult>;
}

interface Context {
  owner: object;
  conn: SqlDriverConnection;
  depth: number;
  done: boolean;
  client: SessionClient;
}

/** Internal marker used by withTransaction and the migrator. */
export const CLIENT_INFO: unique symbol = Symbol.for('@aspec/db.client');

export interface ClientInfo {
  depth: number;
  owner: object;
}

export function clientInfo(client: SqlClient): ClientInfo | undefined {
  return (client as unknown as Record<symbol, ClientInfo | undefined>)[CLIENT_INFO];
}

const ISOLATION_SQL: Record<IsolationLevel, string> = {
  'read uncommitted': 'READ UNCOMMITTED',
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

const SQLITE_BEHAVIOR_SQL = {
  deferred: 'DEFERRED',
  immediate: 'IMMEDIATE',
  exclusive: 'EXCLUSIVE',
} as const;

function validateTransactionOptions(options: TransactionOptions | undefined): void {
  if (!options) return;
  if (options.isolationLevel !== undefined && !(options.isolationLevel in ISOLATION_SQL)) {
    throw new DbError(
      DbErrorCode.TRANSACTION_OPTIONS,
      `Unknown isolation level: ${String(options.isolationLevel)}`,
    );
  }
  if (options.sqliteBehavior !== undefined && !(options.sqliteBehavior in SQLITE_BEHAVIOR_SQL)) {
    throw new DbError(
      DbErrorCode.TRANSACTION_OPTIONS,
      `Unknown sqliteBehavior: ${String(options.sqliteBehavior)}`,
    );
  }
}

/** The BEGIN statement for a dialect and options. */
export function beginStatement(dialect: SqlDialect, options: TransactionOptions = {}): string {
  validateTransactionOptions(options);
  if (dialect === 'postgres') {
    let sql = 'BEGIN';
    if (options.isolationLevel) sql += ` ISOLATION LEVEL ${ISOLATION_SQL[options.isolationLevel]}`;
    if (options.readOnly === true) sql += ' READ ONLY';
    else if (options.readOnly === false) sql += ' READ WRITE';
    return sql;
  }
  const behavior = options.sqliteBehavior ?? (options.readOnly ? 'deferred' : 'immediate');
  return `BEGIN ${SQLITE_BEHAVIOR_SQL[behavior]}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter in [50%, 100%] of the capped delay. */
export function backoffDelay(attempt: number, minDelayMs: number, maxDelayMs: number): number {
  const capped = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
  return Math.round(capped / 2 + (capped / 2) * (randomInt(0, 1001) / 1000));
}

/**
 * Builds a full `Database` on top of a `SqlDriver`. Every driver factory in this package
 * uses it; custom drivers get the same transaction, instrumentation and shutdown semantics.
 */
export function createClientFromDriver(driver: SqlDriver, options: ClientOptions = {}): Database {
  const logger = options.logger ?? noopLogger;
  const secrets = (): readonly string[] => driver.secrets ?? [];
  const instr = createInstrumenter(options, driver.dialect, driver.name, secrets);
  const storage = new AsyncLocalStorage<Context>();
  const owner = {};
  const dialect = driver.dialect;
  let state: DatabaseStats['state'] = 'idle';
  let opening: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let inFlight = 0;
  let drainWaiters: Array<() => void> = [];

  const retry = {
    retries: options.connectRetry?.retries ?? 3,
    minDelayMs: options.connectRetry?.minDelayMs ?? 200,
    maxDelayMs: options.connectRetry?.maxDelayMs ?? 5000,
  };

  const closedError = (): DbError =>
    new DbError(DbErrorCode.CLOSED, 'The database client is closed or closing', { status: 503 });

  const begin = (): void => {
    inFlight++;
  };
  const end = (): void => {
    inFlight--;
    if (inFlight === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const w of waiters) w();
    }
  };

  const openDriver = async (): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await driver.open();
        if (state === 'idle') state = 'open';
        return;
      } catch (error) {
        const message = safeErrorMessage(error, secrets());
        if (attempt >= retry.retries) {
          logger.error(
            { attempts: attempt + 1, err: message, code: errorCode(error) },
            'database connection failed',
          );
          throw new DbError(
            DbErrorCode.CONNECTION_FAILED,
            `Could not connect to the database: ${message}`,
            {
              status: 503,
              cause: error,
              details: { attempts: attempt + 1, driverCode: errorCode(error) },
            },
          );
        }
        const delay = backoffDelay(attempt, retry.minDelayMs, retry.maxDelayMs);
        logger.warn(
          { attempt: attempt + 1, delayMs: delay, err: message },
          'database connection failed, retrying',
        );
        await sleep(delay);
      }
    }
  };

  const ensureOpen = (): Promise<void> => {
    if (state === 'open') return Promise.resolve();
    if (state === 'closing' || state === 'closed') return Promise.reject(closedError());
    if (!opening) {
      opening = openDriver().finally(() => {
        opening = undefined;
      });
    }
    return opening;
  };

  // One connection runs one statement at a time. Callers inside a transaction may issue
  // queries concurrently (for example Promise.all over several reads); queue them here
  // instead of relying on the driver, which pg 9 no longer does.
  const tails = new WeakMap<SqlDriverConnection, Promise<unknown>>();
  const runOn = <R>(
    conn: SqlDriverConnection,
    sql: string,
    params: readonly unknown[],
    inTx: boolean,
  ): Promise<SqlQueryResult<R>> => {
    const run = () =>
      instr.run(sql, params, inTx, () => conn.query(sql, params)) as Promise<SqlQueryResult<R>>;
    const previous = tails.get(conn);
    const next = previous ? previous.then(run, run) : run();
    tails.set(
      conn,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };

  const makeSessionClient = (ctxRef: { ctx?: Context }, depth: number): SessionClient => {
    const client: SessionClient = {
      dialect,
      query<R = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        const ctx = ctxRef.ctx as Context;
        if (ctx.done) {
          return Promise.reject(
            new DbError(
              DbErrorCode.CLOSED,
              'This transaction or connection has already completed',
              { status: 500 },
            ),
          );
        }
        return runOn<R>(ctx.conn, sql, params, depth > 0);
      },
      transaction<T>(
        fn: (tx: SqlClient) => Promise<T>,
        txOptions?: TransactionOptions,
      ): Promise<T> {
        const ctx = ctxRef.ctx as Context;
        if (ctx.done) {
          return Promise.reject(
            new DbError(
              DbErrorCode.CLOSED,
              'This transaction or connection has already completed',
              { status: 500 },
            ),
          );
        }
        return depth === 0
          ? runTransaction(ctx.conn, fn, txOptions)
          : runSavepoint(ctx, fn, txOptions);
      },
    };
    Object.defineProperty(client, CLIENT_INFO, { value: { depth, owner } satisfies ClientInfo });
    return client;
  };

  const withContext = async <T>(
    conn: SqlDriverConnection,
    depth: number,
    fn: (client: SessionClient) => Promise<T>,
  ): Promise<T> => {
    const ref: { ctx?: Context } = {};
    const client = makeSessionClient(ref, depth);
    const ctx: Context = { owner, conn, depth, done: false, client };
    ref.ctx = ctx;
    try {
      return await storage.run(ctx, () => fn(client));
    } finally {
      ctx.done = true;
    }
  };

  const runSavepoint = async <T>(
    parent: Context,
    fn: (tx: SqlClient) => Promise<T>,
    txOptions?: TransactionOptions,
  ): Promise<T> => {
    if (txOptions && (txOptions.isolationLevel !== undefined || txOptions.readOnly !== undefined)) {
      throw new DbError(
        DbErrorCode.TRANSACTION_OPTIONS,
        'isolationLevel and readOnly cannot be changed in a nested transaction',
      );
    }
    const name = `aspec_sp_${parent.depth}`;
    await runOn(parent.conn, `SAVEPOINT ${name}`, [], true);
    try {
      const out = await withContext(parent.conn, parent.depth + 1, fn);
      await runOn(parent.conn, `RELEASE SAVEPOINT ${name}`, [], true);
      return out;
    } catch (error) {
      try {
        await runOn(parent.conn, `ROLLBACK TO SAVEPOINT ${name}`, [], true);
        await runOn(parent.conn, `RELEASE SAVEPOINT ${name}`, [], true);
      } catch (rollbackError) {
        logger.error(
          { err: safeErrorMessage(rollbackError, secrets()) },
          'savepoint rollback failed',
        );
      }
      throw error;
    }
  };

  const runTransaction = async <T>(
    conn: SqlDriverConnection,
    fn: (tx: SqlClient) => Promise<T>,
    txOptions?: TransactionOptions,
    broken?: { value: boolean },
  ): Promise<T> => {
    const beginSql = beginStatement(dialect, txOptions);
    const sqliteReadOnly = dialect === 'sqlite' && txOptions?.readOnly === true;
    await runOn(conn, beginSql, [], true);
    let committed = false;
    try {
      if (sqliteReadOnly) await runOn(conn, 'PRAGMA query_only = ON', [], true);
      const out = await withContext(conn, 1, fn);
      if (sqliteReadOnly) await runOn(conn, 'PRAGMA query_only = OFF', [], true);
      await runOn(conn, 'COMMIT', [], true);
      committed = true;
      return out;
    } catch (error) {
      if (!committed) {
        try {
          await runOn(conn, 'ROLLBACK', [], true);
        } catch (rollbackError) {
          // PostgreSQL ends the transaction when COMMIT fails; a failing ROLLBACK here means the
          // connection itself is unusable, so the caller discards it.
          logger.warn({ err: safeErrorMessage(rollbackError, secrets()) }, 'rollback failed');
          if (broken) broken.value = true;
        } finally {
          if (sqliteReadOnly) {
            await runOn(conn, 'PRAGMA query_only = OFF', [], true).catch(() => undefined);
          }
        }
      }
      throw error;
    }
  };

  const acquireAndRun = async <T>(
    fn: (conn: SqlDriverConnection, broken: { value: boolean }) => Promise<T>,
  ): Promise<T> => {
    if (state === 'closing' || state === 'closed') throw closedError();
    begin();
    try {
      await ensureOpen();
      const conn = await driver.acquire();
      const broken = { value: false };
      try {
        return await fn(conn, broken);
      } finally {
        conn.release(broken.value);
      }
    } finally {
      end();
    }
  };

  const ambient = (): Context | undefined => {
    const ctx = storage.getStore();
    return ctx && ctx.owner === owner && !ctx.done ? ctx : undefined;
  };

  const db: Database = {
    dialect,
    driverName: driver.name,

    async query<R = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      const ctx = ambient();
      if (ctx) return ctx.client.query<R>(sql, params);
      if (state === 'closing' || state === 'closed') throw closedError();
      begin();
      try {
        await ensureOpen();
        return (await instr.run(sql, params, false, () =>
          driver.query(sql, params),
        )) as SqlQueryResult<R>;
      } finally {
        end();
      }
    },

    transaction<T>(fn: (tx: SqlClient) => Promise<T>, txOptions?: TransactionOptions): Promise<T> {
      const ctx = ambient();
      if (ctx) return ctx.client.transaction(fn, txOptions);
      try {
        validateTransactionOptions(txOptions);
      } catch (error) {
        return Promise.reject(error);
      }
      return acquireAndRun((conn, broken) => runTransaction(conn, fn, txOptions, broken));
    },

    connection<T>(fn: (conn: SessionClient) => Promise<T>): Promise<T> {
      const ctx = ambient();
      if (ctx) return fn(ctx.client);
      return acquireAndRun((conn) => withContext(conn, 0, fn));
    },

    async connect() {
      if (state === 'closing' || state === 'closed') throw closedError();
      begin();
      try {
        await ensureOpen();
      } finally {
        end();
      }
    },

    close(closeOptions?: { timeoutMs?: number }) {
      if (closing) return closing;
      state = 'closing';
      const timeoutMs = closeOptions?.timeoutMs ?? options.closeTimeoutMs ?? 10_000;
      closing = (async () => {
        if (inFlight > 0) {
          let timer: NodeJS.Timeout | undefined;
          const drained = await Promise.race([
            new Promise<boolean>((resolve) => drainWaiters.push(() => resolve(true))),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), timeoutMs);
            }),
          ]);
          if (timer) clearTimeout(timer);
          if (!drained) {
            logger.warn({ inFlight, timeoutMs }, 'closing database with work still in flight');
          }
        }
        if (opening) await opening.catch(() => undefined);
        try {
          await driver.close();
        } finally {
          state = 'closed';
        }
      })();
      return closing;
    },

    stats() {
      return {
        dialect,
        driver: driver.name,
        state,
        pool: driver.stats(),
        queries: instr.counters.queries,
        errors: instr.counters.errors,
        slowQueries: instr.counters.slowQueries,
        inFlight,
      };
    },

    async checkHealth(healthOptions?: { timeoutMs?: number }) {
      const timeoutMs = healthOptions?.timeoutMs ?? options.healthTimeoutMs ?? 2000;
      const started = performance.now();
      const base = { dialect, driver: driver.name };
      if (state === 'closing' || state === 'closed') {
        return { ok: false, latencyMs: 0, details: { ...base, error: 'closed' } };
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          db.query('SELECT 1'),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new DbError(DbErrorCode.TIMEOUT, `Health check timed out after ${timeoutMs} ms`),
                ),
              timeoutMs,
            );
          }),
        ]);
        return {
          ok: true,
          latencyMs: Math.round((performance.now() - started) * 100) / 100,
          details: { ...base, pool: driver.stats() },
        };
      } catch (error) {
        return {
          ok: false,
          latencyMs: Math.round((performance.now() - started) * 100) / 100,
          details: {
            ...base,
            pool: driver.stats(),
            error: safeErrorMessage(error, secrets()),
            code: errorCode(error),
          },
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
  Object.defineProperty(db, CLIENT_INFO, { value: { depth: 0, owner } satisfies ClientInfo });
  return db;
}

export type { Row };
