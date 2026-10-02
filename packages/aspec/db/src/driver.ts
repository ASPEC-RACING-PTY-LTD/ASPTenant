import type { SqlDialect, SqlQueryResult } from './ports.js';

export type Row = Record<string, unknown>;

export interface PoolStats {
  /** Open connections (checked out plus idle). */
  total: number;
  /** Idle connections ready for use. */
  idle: number;
  /** Callers waiting for a connection. */
  waiting: number;
  /** Configured maximum. */
  max: number;
}

/** A connection held exclusively by one caller until `release()`. */
export interface SqlDriverConnection {
  /**
   * Executes one query. `sql` uses `$1..$n` placeholders; drivers for engines with other
   * placeholder styles rewrite them. Parameterless SQL may contain several statements.
   */
  query(sql: string, params: readonly unknown[]): Promise<SqlQueryResult<Row>>;
  /** Returns the connection. `destroy` discards it (used after a failed rollback). */
  release(destroy?: boolean): void;
}

/**
 * Adapter boundary between @aspec/db and a database driver. The generic client
 * (`createClientFromDriver`) adds transactions, savepoints, retries, instrumentation, health
 * checks and graceful shutdown on top of any implementation.
 *
 * To support another engine, implement this interface: map placeholders and parameters in
 * `query`, give exclusive connections from `acquire` (a single-connection engine queues
 * callers), and report pool statistics. Adding a dialect outside `postgres` and `sqlite`
 * also requires extending the `SqlDialect` port, which is a breaking port change.
 */
export interface SqlDriver {
  readonly dialect: SqlDialect;
  /** Driver identifier, for example `pg`, `better-sqlite3` or `node:sqlite`. */
  readonly name: string;
  /** Opens resources and verifies connectivity. Must be safe to call again after a failure. */
  open(): Promise<void>;
  /** Runs a query on any available connection. */
  query(sql: string, params: readonly unknown[]): Promise<SqlQueryResult<Row>>;
  /** Checks out a dedicated connection (transactions, session locks). */
  acquire(): Promise<SqlDriverConnection>;
  stats(): PoolStats;
  /** Releases every resource. Called once, after in-flight work has drained. */
  close(): Promise<void>;
  /** Values removed from log lines and error messages (passwords). */
  readonly secrets?: readonly string[];
}
