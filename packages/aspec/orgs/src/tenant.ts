import { AsyncLocalStorage } from 'node:async_hooks';
import { OrgsError } from './errors.js';
import type { SqlClient } from './ports.js';
import type { TenantContext, TenantStrategy } from './types.js';

const storage = new AsyncLocalStorage<TenantContext>();

/** Runs `fn` with the given tenant context bound to the current async scope. */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Current tenant context, or `undefined` outside `runWithTenant`. */
export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}

/** Current tenant context, or throws `ORGS_TENANT_REQUIRED`. */
export function requireTenant(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) throw new OrgsError('ORGS_TENANT_REQUIRED', 'No tenant context is active');
  return ctx;
}

/**
 * Wraps a SqlClient so that every transaction sets `app.tenant_id` for PostgreSQL RLS.
 * Outside transactions, queries pass through unchanged (set the GUC inside a transaction).
 */
export function tenantScope(client: SqlClient, orgId?: string): SqlClient {
  const resolveId = () => orgId ?? storage.getStore()?.orgId;
  return {
    dialect: client.dialect,
    query: (sql, params) => client.query(sql, params),
    async transaction(fn) {
      return client.transaction(async (tx) => {
        const id = resolveId();
        if (client.dialect === 'postgres' && id) {
          await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
        }
        return fn(tx);
      });
    },
  };
}

export interface RlsPolicyOptions {
  /** Table names (without schema) that should enforce tenant_id. */
  tables: readonly string[];
  /** Column holding the organisation/tenant id. Default `tenant_id`. */
  column?: string;
  /** Role the policies apply to. Default `PUBLIC`. */
  role?: string;
  /** When true, emit `FORCE ROW LEVEL SECURITY`. Default true. */
  force?: boolean;
}

/**
 * Generates PostgreSQL RLS policy SQL for shared-schema multi-tenancy.
 * Policies compare `current_setting('app.tenant_id', true)` to the tenant column.
 * Use a non-superuser role (or FORCE RLS) so table owners are also constrained.
 */
export function generateRlsPolicySql(options: RlsPolicyOptions): string {
  const column = options.column ?? 'tenant_id';
  const role = options.role ?? 'PUBLIC';
  const force = options.force !== false;
  const parts: string[] = [];
  for (const table of options.tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(table)) {
      throw new OrgsError('ORGS_CONFIG_INVALID', `Invalid RLS table name: ${table}`);
    }
    if (!/^[a-z][a-z0-9_]*$/.test(column)) {
      throw new OrgsError('ORGS_CONFIG_INVALID', `Invalid RLS column name: ${column}`);
    }
    parts.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    if (force) parts.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    parts.push(`DROP POLICY IF EXISTS orgs_tenant_isolation ON ${table};`);
    parts.push(
      `CREATE POLICY orgs_tenant_isolation ON ${table} FOR ALL TO ${role} ` +
        `USING (${column} = NULLIF(current_setting('app.tenant_id', true), '')) ` +
        `WITH CHECK (${column} = NULLIF(current_setting('app.tenant_id', true), ''));`,
    );
  }
  return parts.join('\n');
}

export type { TenantStrategy };
