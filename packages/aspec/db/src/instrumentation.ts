import type { LoggerLike, SqlDialect } from './ports.js';
import { errorCode, redactText } from './redact.js';

export type AttributeValue = string | number | boolean;

/** Structural subset of an OpenTelemetry `Span`. */
export interface SpanLike {
  setAttribute(key: string, value: AttributeValue): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException(exception: Error): unknown;
  end(): void;
}

/** Structural subset of an OpenTelemetry `Tracer` (`trace.getTracer(...)`). */
export interface TracerLike {
  startSpan(
    name: string,
    options?: { kind?: number; attributes?: Record<string, AttributeValue> },
  ): SpanLike;
}

export interface QueryEvent {
  /** SQL text with password literals (`PASSWORD '...'`) redacted. */
  sql: string;
  /** Parameters, replaced by `[REDACTED]` unless `logParameters` is true. */
  params: readonly unknown[];
  durationMs: number;
  rowCount?: number;
  error?: unknown;
  dialect: SqlDialect;
  driver: string;
  inTransaction: boolean;
}

export interface InstrumentationOptions {
  /** Called after every query, including transaction control statements. Must not throw. */
  onQuery?: (event: QueryEvent) => void;
  /** LoggerLike (pino convention) for slow queries, connection retries and pool errors. */
  logger?: LoggerLike;
  /** Queries slower than this are logged at warn level. Disabled when undefined. */
  slowQueryThresholdMs?: number;
  /** Include real parameter values in events and logs. Default false. */
  logParameters?: boolean;
  /** OpenTelemetry tracer (or structural equivalent). One CLIENT span per query. */
  tracer?: TracerLike;
}

export const noopLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const MAX_LOGGED_SQL = 2000;
const PASSWORD_LITERAL = /(\bpassword\s+)'(?:[^']|'')*'/gi;
const SPAN_KIND_CLIENT = 2;
const SPAN_STATUS_ERROR = 2;
const REDACTED_PARAM = '[REDACTED]';

/** Removes password literals from SQL text (for example `ALTER ROLE x PASSWORD '...'`). */
export function redactSql(sql: string): string {
  return sql.replace(PASSWORD_LITERAL, "$1'***'");
}

function truncate(sql: string): string {
  return sql.length > MAX_LOGGED_SQL ? `${sql.slice(0, MAX_LOGGED_SQL)}...` : sql;
}

function operationName(sql: string): string {
  const match = /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*([A-Za-z]+)/.exec(sql);
  return match?.[1] ? match[1].toUpperCase() : 'QUERY';
}

export interface Instrumenter {
  run<T extends { rowCount: number }>(
    sql: string,
    params: readonly unknown[],
    inTransaction: boolean,
    exec: () => Promise<T>,
  ): Promise<T>;
  readonly counters: { queries: number; errors: number; slowQueries: number };
}

export function createInstrumenter(
  options: InstrumentationOptions,
  dialect: SqlDialect,
  driver: string,
  secrets: () => readonly string[],
): Instrumenter {
  const logger = options.logger ?? noopLogger;
  const { onQuery, tracer, slowQueryThresholdMs } = options;
  const counters = { queries: 0, errors: 0, slowQueries: 0 };
  const system = dialect === 'postgres' ? 'postgresql' : 'sqlite';

  return {
    counters,
    async run(sql, params, inTransaction, exec) {
      counters.queries++;
      const detailed =
        onQuery !== undefined || tracer !== undefined || slowQueryThresholdMs !== undefined;
      if (!detailed) {
        try {
          return await exec();
        } catch (error) {
          counters.errors++;
          throw error;
        }
      }
      const safeSql = redactSql(sql);
      let span: SpanLike | undefined;
      if (tracer) {
        try {
          span = tracer.startSpan(`db ${operationName(sql)}`, {
            kind: SPAN_KIND_CLIENT,
            attributes: { 'db.system': system, 'db.statement': truncate(safeSql) },
          });
        } catch {
          span = undefined;
        }
      }
      const started = performance.now();
      let rowCount: number | undefined;
      let failure: unknown;
      let failed = false;
      try {
        const result = await exec();
        rowCount = result.rowCount;
        return result;
      } catch (error) {
        failed = true;
        failure = error;
        counters.errors++;
        throw error;
      } finally {
        const durationMs = performance.now() - started;
        const shownParams = options.logParameters ? params : params.map(() => REDACTED_PARAM);
        if (span) {
          try {
            if (rowCount !== undefined) span.setAttribute('db.response.rows', rowCount);
            if (failed) {
              const message = redactText(
                failure instanceof Error ? failure.message : String(failure),
                secrets(),
              );
              span.setStatus({ code: SPAN_STATUS_ERROR, message });
              if (failure instanceof Error) span.recordException(failure);
            }
            span.end();
          } catch {
            // Tracing must never affect query results.
          }
        }
        if (slowQueryThresholdMs !== undefined && durationMs >= slowQueryThresholdMs) {
          counters.slowQueries++;
          logger.warn(
            {
              sql: truncate(safeSql),
              params: shownParams,
              durationMs: Math.round(durationMs),
              rowCount,
              thresholdMs: slowQueryThresholdMs,
              dialect,
              ...(failed ? { errorCode: errorCode(failure) } : {}),
            },
            'slow query',
          );
        }
        if (onQuery) {
          const event: QueryEvent = {
            sql: safeSql,
            params: shownParams,
            durationMs,
            dialect,
            driver,
            inTransaction,
          };
          if (rowCount !== undefined) event.rowCount = rowCount;
          if (failed) event.error = failure;
          try {
            onQuery(event);
          } catch (hookError) {
            logger.error(
              {
                err: redactText(
                  hookError instanceof Error ? hookError.message : String(hookError),
                  secrets(),
                ),
              },
              'onQuery hook threw; ignoring',
            );
          }
        }
      }
    },
  };
}
