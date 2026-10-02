export const DbErrorCode = {
  CONFIG_INVALID: 'DB_CONFIG_INVALID',
  DRIVER_MISSING: 'DB_DRIVER_MISSING',
  CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  CLOSED: 'DB_CLOSED',
  TIMEOUT: 'DB_TIMEOUT',
  MULTI_STATEMENT: 'DB_MULTI_STATEMENT',
  PARAMETER_MISMATCH: 'DB_PARAMETER_MISMATCH',
  TRANSACTION_OPTIONS: 'DB_TRANSACTION_OPTIONS',
  MIGRATION_INVALID: 'DB_MIGRATION_INVALID',
  MIGRATION_CHECKSUM_MISMATCH: 'DB_MIGRATION_CHECKSUM_MISMATCH',
  MIGRATION_IRREVERSIBLE: 'DB_MIGRATION_IRREVERSIBLE',
  MIGRATION_LOCK_TIMEOUT: 'DB_MIGRATION_LOCK_TIMEOUT',
  MIGRATION_FAILED: 'DB_MIGRATION_FAILED',
  SEED_REFUSED: 'DB_SEED_REFUSED',
  SEED_FAILED: 'DB_SEED_FAILED',
} as const;

export type DbErrorCode = (typeof DbErrorCode)[keyof typeof DbErrorCode];

export interface DbErrorOptions {
  status?: number;
  expose?: boolean;
  details?: unknown;
  cause?: unknown;
}

/**
 * Base class for every error raised by @aspec/db itself. Driver errors from PostgreSQL or
 * SQLite (constraint violations and so on) are passed through unchanged so callers can
 * inspect driver codes such as `23505`.
 */
export class DbError extends Error {
  readonly code: DbErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details: unknown;

  constructor(code: DbErrorCode, message: string, options: DbErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DbError';
    this.code = code;
    this.status = options.status ?? 500;
    this.expose = options.expose ?? false;
    this.details = options.details;
  }
}

export function isDbError(value: unknown): value is DbError {
  return value instanceof DbError;
}
