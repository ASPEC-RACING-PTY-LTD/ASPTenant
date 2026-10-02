// Structural integration ports copied verbatim from docs/architecture/integration-ports.md.

export type SqlDialect = 'postgres' | 'sqlite';

export interface SqlQueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface SqlClient {
  readonly dialect: SqlDialect;
  /**
   * Positional placeholders are always $1, $2, ... regardless of dialect.
   * A query without parameters may contain several statements separated by semicolons
   * (used by migrations); a query with parameters must contain exactly one statement.
   */
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
  /** Runs fn inside a transaction. Nested calls use savepoints or join the outer transaction. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

export interface LoggerLike {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface AuditEventInput {
  action: string;
  outcome?: 'success' | 'failure' | 'denied';
  actor?: { id: string; type?: string; ip?: string; userAgent?: string };
  resource?: { type: string; id?: string };
  tenantId?: string;
  requestId?: string;
  changes?: { before?: unknown; after?: unknown };
  metadata?: Record<string, unknown>;
  category?: 'security' | 'data' | 'admin' | 'system';
}

export interface AuditSink {
  record(event: AuditEventInput): Promise<unknown>;
}

export interface CacheLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, options?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs?: number;
}

export interface RateLimiterLike {
  consume(key: string, cost?: number): Promise<RateLimitDecision>;
}

export interface Subject {
  id: string;
  type?: 'user' | 'service' | 'api_key' | (string & {});
  roles?: readonly string[];
  orgId?: string;
  teamIds?: readonly string[];
  attributes?: Record<string, unknown>;
}

export interface ResourceRef {
  type: string;
  id?: string;
  ownerId?: string;
  orgId?: string;
  teamId?: string;
  attributes?: Record<string, unknown>;
}

export interface PermissionChecker {
  can(subject: Subject, permission: string, resource?: ResourceRef): Promise<boolean>;
}

export interface Clock {
  now(): number;
}

export type IdGenerator = () => string;
