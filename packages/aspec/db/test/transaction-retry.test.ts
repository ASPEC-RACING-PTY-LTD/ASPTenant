import { describe, expect, it } from 'vitest';
import type { SqlClient, SqlQueryResult } from '../src/ports.js';
import { isRetryableTransactionError, withTransaction } from '../src/transaction.js';

describe('withTransaction retries', () => {
  it('recognises PostgreSQL and SQLite retryable codes', () => {
    expect(isRetryableTransactionError({ code: '40001' })).toBe(true);
    expect(isRetryableTransactionError({ code: '40P01' })).toBe(true);
    expect(isRetryableTransactionError({ code: 'SQLITE_BUSY' })).toBe(true);
    expect(isRetryableTransactionError({ code: '23505' })).toBe(false);
  });

  it('retries on forced serialization failures', async () => {
    let attempts = 0;
    const client: SqlClient = {
      dialect: 'postgres',
      async query<Row = Record<string, unknown>>(): Promise<SqlQueryResult<Row>> {
        return { rows: [], rowCount: 0 };
      },
      async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
        attempts++;
        if (attempts < 3) {
          const err = Object.assign(new Error('serialization'), { code: '40001' });
          throw err;
        }
        return fn(client);
      },
    };
    const delays: number[] = [];
    const result = await withTransaction(client, async () => 'ok', {
      retries: 5,
      minDelayMs: 1,
      maxDelayMs: 2,
      onRetry: (info) => delays.push(info.delayMs),
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(delays).toHaveLength(2);
  });
});
