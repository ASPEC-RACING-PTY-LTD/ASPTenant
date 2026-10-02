import { clientInfo } from './client.js';
import { DbError, DbErrorCode } from './errors.js';
import type { HealthCheckable, HealthCheckResult, SqlClient } from './ports.js';
import { errorCode, safeErrorMessage } from './redact.js';

export interface HealthCheckOptions {
  /** Default 2000 ms. */
  timeoutMs?: number;
}

/**
 * Runs `SELECT 1` against any SqlClient with a timeout and reports latency. Never throws.
 * Clients created by this package also report pool statistics.
 */
export async function checkDatabaseHealth(
  client: SqlClient,
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const own = client as SqlClient & {
    checkHealth?: (o?: HealthCheckOptions) => Promise<HealthCheckResult>;
  };
  if (clientInfo(client) && typeof own.checkHealth === 'function') return own.checkHealth(options);
  const timeoutMs = options.timeoutMs ?? 2000;
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.query('SELECT 1'),
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
      details: { dialect: client.dialect },
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      details: { dialect: client.dialect, error: safeErrorMessage(error), code: errorCode(error) },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Wraps any SqlClient as a HealthCheckable (for @aspec/observability and similar). */
export function createHealthCheck(
  client: SqlClient,
  options: HealthCheckOptions = {},
): HealthCheckable {
  return { checkHealth: () => checkDatabaseHealth(client, options) };
}
