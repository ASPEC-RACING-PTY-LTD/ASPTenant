import { backoffDelay, beginStatement, clientInfo, type TransactionOptions } from './client.js';
import { DbError, DbErrorCode } from './errors.js';
import type { SqlClient } from './ports.js';

export interface RetryInfo {
  /** 1 for the first retry. */
  attempt: number;
  error: unknown;
  delayMs: number;
}

export interface WithTransactionOptions extends TransactionOptions {
  /** Retries after a serialization failure, deadlock or SQLITE_BUSY. Default 3. */
  retries?: number;
  /** First backoff delay. Default 10 ms, doubled per attempt with jitter. */
  minDelayMs?: number;
  /** Maximum backoff delay. Default 500 ms. */
  maxDelayMs?: number;
  onRetry?: (info: RetryInfo) => void;
}

/**
 * True for errors where re-running the whole transaction can succeed: PostgreSQL
 * serialization failures (40001) and deadlocks (40P01), SQLite SQLITE_BUSY and SQLITE_LOCKED.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const e = error as { code?: unknown; errcode?: unknown };
  if (e.code === '40001' || e.code === '40P01') return true;
  if (typeof e.code === 'string' && /^SQLITE_(BUSY|LOCKED)/.test(e.code)) return true;
  if (typeof e.errcode === 'number' && ((e.errcode & 0xff) === 5 || (e.errcode & 0xff) === 6))
    return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce<T>(
  client: SqlClient,
  fn: (tx: SqlClient) => Promise<T>,
  options: TransactionOptions,
): Promise<T> {
  const info = clientInfo(client);
  const hasOptions =
    options.isolationLevel !== undefined ||
    options.readOnly !== undefined ||
    options.sqliteBehavior !== undefined;
  if (info) {
    // Clients from this package accept options directly.
    const native = client as SqlClient & {
      transaction<R>(f: (tx: SqlClient) => Promise<R>, o?: TransactionOptions): Promise<R>;
    };
    return hasOptions ? native.transaction(fn, options) : native.transaction(fn);
  }
  if (!hasOptions) return client.transaction(fn);
  // Any other SqlClient: apply the options as the first statement of the transaction.
  return client.transaction(async (tx) => {
    if (tx.dialect === 'postgres') {
      const clause = beginStatement('postgres', options)
        .replace(/^BEGIN/, '')
        .trim();
      if (clause) await tx.query(`SET TRANSACTION ${clause}`);
      return fn(tx);
    }
    if (options.readOnly) {
      await tx.query('PRAGMA query_only = ON');
      try {
        return await fn(tx);
      } finally {
        await tx.query('PRAGMA query_only = OFF');
      }
    }
    return fn(tx);
  });
}

/**
 * Runs fn in a transaction and re-runs the whole transaction on serialization failures,
 * deadlocks and SQLITE_BUSY, with jittered exponential backoff. fn may run more than once,
 * so side effects outside the database must be idempotent. Called with a transaction
 * client (nested), it creates a savepoint and does not retry, because a retryable error
 * aborts the outer transaction.
 */
export async function withTransaction<T>(
  client: SqlClient,
  fn: (tx: SqlClient) => Promise<T>,
  options: WithTransactionOptions = {},
): Promise<T> {
  const { retries = 3, minDelayMs = 10, maxDelayMs = 500, onRetry, ...txOptions } = options;
  if (!Number.isInteger(retries) || retries < 0 || retries > 100) {
    throw new DbError(
      DbErrorCode.TRANSACTION_OPTIONS,
      'retries must be an integer between 0 and 100',
    );
  }
  const info = clientInfo(client);
  if (info && info.depth > 0) {
    if (txOptions.isolationLevel !== undefined || txOptions.readOnly !== undefined) {
      throw new DbError(
        DbErrorCode.TRANSACTION_OPTIONS,
        'isolationLevel and readOnly cannot be changed in a nested transaction',
      );
    }
    return client.transaction(fn);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(client, fn, txOptions);
    } catch (error) {
      if (attempt >= retries || !isRetryableTransactionError(error)) throw error;
      const delayMs = backoffDelay(attempt, minDelayMs, maxDelayMs);
      onRetry?.({ attempt: attempt + 1, error, delayMs });
      await sleep(delayMs);
    }
  }
}
