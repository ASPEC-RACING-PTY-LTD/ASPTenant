// Integration ports copied verbatim from docs/architecture/integration-ports.md.
// Declared locally so @aspec/testing never depends on another ASPEC module.

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

export interface Subject {
  id: string;
  type?: 'user' | 'service' | 'api_key' | (string & {});
  roles?: readonly string[]; // statically asserted roles (e.g. from a token)
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
  now(): number; // epoch ms
}
export type IdGenerator = () => string;
