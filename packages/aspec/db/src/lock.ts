import { createHash } from 'node:crypto';
import { clientInfo, type SessionClient } from './client.js';
import { DbError, DbErrorCode } from './errors.js';
import type { SqlClient } from './ports.js';

export interface LockScope {
  /** The client to run work on while the lock is held. */
  conn: SqlClient;
  /**
   * Set when a session lock could not be taken (a SqlClient from another library): each
   * transaction must take `pg_advisory_xact_lock(<key>)` itself.
   */
  transactionLockKey?: string;
}

/** Signed 64-bit advisory lock key derived from a name. */
export function advisoryLockKey(name: string): string {
  const digest = createHash('sha256').update(`aspec-db:${name}`).digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0)).toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function currentSchema(conn: SqlClient): Promise<string> {
  const result = await conn.query<{ schema: string | null }>('SELECT current_schema() AS schema');
  return result.rows[0]?.schema ?? 'public';
}

/**
 * Serialises migration and seed runs. PostgreSQL clients from this package hold a session
 * advisory lock (keyed by schema and table) on a dedicated connection for the whole run and
 * poll `pg_try_advisory_lock` until `timeoutMs`. SQLite clients hold the connection queue,
 * and each migration transaction starts with `BEGIN IMMEDIATE` for cross-process safety.
 */
export async function withRunLock<T>(
  client: SqlClient,
  name: string,
  options: { timeoutMs: number; pollMs?: number },
  body: (scope: LockScope) => Promise<T>,
): Promise<T> {
  const info = clientInfo(client);
  const withConnection = (
    client as { connection?: <R>(fn: (c: SessionClient) => Promise<R>) => Promise<R> }
  ).connection;
  if (!info || typeof withConnection !== 'function') {
    if (client.dialect === 'postgres') {
      const schema = await currentSchema(client);
      return body({ conn: client, transactionLockKey: advisoryLockKey(`${schema}.${name}`) });
    }
    return body({ conn: client });
  }
  return withConnection.call<SqlClient, [(c: SessionClient) => Promise<T>], Promise<T>>(
    client,
    async (conn) => {
      if (conn.dialect !== 'postgres') return body({ conn });
      const key = advisoryLockKey(`${await currentSchema(conn)}.${name}`);
      const deadline = Date.now() + options.timeoutMs;
      const pollMs = options.pollMs ?? 200;
      for (;;) {
        const result = await conn.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1::bigint) AS locked',
          [key],
        );
        if (result.rows[0]?.locked) break;
        if (Date.now() >= deadline) {
          throw new DbError(
            DbErrorCode.MIGRATION_LOCK_TIMEOUT,
            `Timed out after ${options.timeoutMs} ms waiting for the ${name} lock; another runner is active`,
            { status: 503, details: { lock: name } },
          );
        }
        await sleep(pollMs);
      }
      try {
        return await body({ conn });
      } finally {
        await conn.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => undefined);
      }
    },
  );
}

const PREFIX = /^(?:[a-z_][a-z0-9_]{0,40})?$/;

/** Validates a table prefix (identifier characters only; never from user input). */
export function tableName(prefix: string, base: string): string {
  if (!PREFIX.test(prefix)) {
    throw new DbError(
      DbErrorCode.CONFIG_INVALID,
      'tablePrefix must be empty or start with a lowercase letter or underscore and contain only a-z, 0-9 and _ (at most 41 characters)',
    );
  }
  return `${prefix}${base}`;
}

export async function tableExists(client: SqlClient, table: string): Promise<boolean> {
  if (client.dialect === 'postgres') {
    const result = await client.query<{ oid: string | null }>(
      'SELECT to_regclass($1)::text AS oid',
      [table],
    );
    return result.rows[0]?.oid != null;
  }
  const result = await client.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1",
    [table],
  );
  return result.rows.length > 0;
}
