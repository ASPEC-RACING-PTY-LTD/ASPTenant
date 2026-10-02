// Structural integration ports copied verbatim from docs/architecture/integration-ports.md.
// Any object with the same shape satisfies them; no other ASPEC module is imported.

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

export interface EnqueueOptions {
  delayMs?: number;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  jobId?: string;
}

export interface JobQueue {
  add(name: string, payload: unknown, options?: EnqueueOptions): Promise<{ id: string }>;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

export interface Mailer {
  send(message: MailMessage): Promise<{ id?: string }>;
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
