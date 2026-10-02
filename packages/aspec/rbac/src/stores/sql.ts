import type { PolicyCondition } from '../conditions.js';
import { RbacConfigError } from '../errors.js';
import type { SqlClient } from '../ports.js';
import type {
  AssignmentFilter,
  GrantFilter,
  GrantLookup,
  PrincipalGrantLookup,
  RbacStore,
  StorePage,
} from '../store.js';
import type {
  AssignmentRecord,
  Effect,
  GrantRecord,
  OwnershipRuleRecord,
  Page,
  PermissionRecord,
  PolicyRecord,
  RoleRecord,
  ScopeKind,
} from '../types.js';

export type { SqlClient, SqlDialect, SqlQueryResult } from '../ports.js';

export interface Migration {
  id: string;
  postgres: string;
  sqlite: string;
}

export interface SqlStoreOptions {
  /** Table name prefix. Identifier characters only. Default `rbac_`. */
  tablePrefix?: string;
}

export const DEFAULT_TABLE_PREFIX = 'rbac_';
const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;

function checkPrefix(prefix: string): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new RbacConfigError(
      'tablePrefix must match ^[a-z][a-z0-9_]{0,30}$ (lowercase letters, digits, underscores)',
      [{ path: 'tablePrefix', message: 'invalid identifier' }],
    );
  }
  return prefix;
}

/** Builds the migration list for a table prefix. */
export function createMigrations(tablePrefix: string = DEFAULT_TABLE_PREFIX): readonly Migration[] {
  const p = checkPrefix(tablePrefix);
  const postgres = `
CREATE TABLE IF NOT EXISTS ${p}permissions (
  key TEXT PRIMARY KEY,
  description TEXT,
  system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${p}roles (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  permissions JSONB NOT NULL,
  denies JSONB NOT NULL,
  parents JSONB NOT NULL,
  assignable_scopes JSONB NOT NULL,
  system BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${p}meta (
  key TEXT PRIMARY KEY,
  value BIGINT NOT NULL
);
INSERT INTO ${p}meta (key, value) VALUES ('roles_revision', 0) ON CONFLICT (key) DO NOTHING;
CREATE TABLE IF NOT EXISTS ${p}assignments (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  role_key TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT '',
  team_id TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  created_by TEXT,
  expires_at BIGINT,
  CONSTRAINT ${p}assignments_unique UNIQUE (subject_id, role_key, org_id, team_id)
);
CREATE INDEX IF NOT EXISTS ${p}assignments_role_idx ON ${p}assignments (role_key);
CREATE INDEX IF NOT EXISTS ${p}assignments_scope_idx ON ${p}assignments (org_id, team_id);
CREATE TABLE IF NOT EXISTS ${p}grants (
  id TEXT PRIMARY KEY,
  subject_id TEXT,
  role_key TEXT,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT '',
  permissions JSONB NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  created_at BIGINT NOT NULL,
  created_by TEXT,
  expires_at BIGINT,
  CHECK ((subject_id IS NULL) <> (role_key IS NULL))
);
CREATE INDEX IF NOT EXISTS ${p}grants_resource_idx ON ${p}grants (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS ${p}grants_subject_idx ON ${p}grants (subject_id);
CREATE INDEX IF NOT EXISTS ${p}grants_role_idx ON ${p}grants (role_key);
CREATE TABLE IF NOT EXISTS ${p}ownership_rules (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  permissions JSONB NOT NULL,
  description TEXT,
  system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${p}policies (
  id TEXT PRIMARY KEY,
  description TEXT,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  permissions JSONB NOT NULL,
  resource_types JSONB,
  roles JSONB,
  condition_json JSONB NOT NULL,
  system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);`;
  const sqlite = postgres
    .replaceAll('JSONB', 'TEXT')
    .replaceAll('BIGINT', 'INTEGER')
    .replaceAll('BOOLEAN NOT NULL DEFAULT FALSE', 'INTEGER NOT NULL DEFAULT 0');
  return Object.freeze([Object.freeze({ id: '001_initial', postgres, sqlite })]);
}

/** Migrations for the default `rbac_` prefix. */
export const migrations: readonly Migration[] = createMigrations();

/**
 * Applies pending migrations idempotently, recording them in `<prefix>schema_migrations`.
 * Safe to run concurrently on PostgreSQL (advisory transaction lock).
 */
export async function migrate(client: SqlClient, options: SqlStoreOptions = {}): Promise<void> {
  const p = checkPrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
  const list = createMigrations(p);
  const bigint = client.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${p}schema_migrations (id TEXT PRIMARY KEY, applied_at ${bigint} NOT NULL)`,
  );
  await client.transaction(async (tx) => {
    if (tx.dialect === 'postgres') {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${p}schema_migrations`]);
    }
    const applied = await tx.query<{ id: string }>(`SELECT id FROM ${p}schema_migrations`);
    const done = new Set(applied.rows.map((r) => r.id));
    for (const m of list) {
      if (done.has(m.id)) continue;
      await tx.query(tx.dialect === 'postgres' ? m.postgres : m.sqlite);
      await tx.query(
        `INSERT INTO ${p}schema_migrations (id, applied_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [m.id, Date.now()],
      );
    }
  });
}

type Row = Record<string, unknown>;

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function optNum(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : num(value);
}

function optStr(value: unknown): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : String(value);
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't';
}

function json<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function optJson<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : json<T>(value);
}

function toPermission(r: Row): PermissionRecord {
  const out: PermissionRecord = {
    key: String(r.key),
    system: bool(r.system),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
  const description = optStr(r.description);
  if (description !== undefined) out.description = description;
  return out;
}

function toRole(r: Row): RoleRecord {
  const out: RoleRecord = {
    key: String(r.key),
    name: String(r.name),
    permissions: json<string[]>(r.permissions),
    denies: json<string[]>(r.denies),
    parents: json<string[]>(r.parents),
    assignableScopes: json<ScopeKind[]>(r.assignable_scopes),
    system: bool(r.system),
    version: num(r.version),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
  const description = optStr(r.description);
  if (description !== undefined) out.description = description;
  return out;
}

function toAssignment(r: Row): AssignmentRecord {
  const out: AssignmentRecord = {
    id: String(r.id),
    subjectId: String(r.subject_id),
    roleKey: String(r.role_key),
    createdAt: num(r.created_at),
  };
  const orgId = optStr(r.org_id);
  const teamId = optStr(r.team_id);
  const createdBy = optStr(r.created_by);
  const expiresAt = optNum(r.expires_at);
  if (orgId !== undefined) out.orgId = orgId;
  if (teamId !== undefined) out.teamId = teamId;
  if (createdBy !== undefined) out.createdBy = createdBy;
  if (expiresAt !== undefined) out.expiresAt = expiresAt;
  return out;
}

function toGrant(r: Row): GrantRecord {
  const out: GrantRecord = {
    id: String(r.id),
    resourceType: String(r.resource_type),
    resourceId: String(r.resource_id),
    permissions: json<string[]>(r.permissions),
    effect: String(r.effect) as Effect,
    createdAt: num(r.created_at),
  };
  const subjectId = optStr(r.subject_id);
  const roleKey = optStr(r.role_key);
  const orgId = optStr(r.org_id);
  const createdBy = optStr(r.created_by);
  const expiresAt = optNum(r.expires_at);
  if (subjectId !== undefined) out.subjectId = subjectId;
  if (roleKey !== undefined) out.roleKey = roleKey;
  if (orgId !== undefined) out.orgId = orgId;
  if (createdBy !== undefined) out.createdBy = createdBy;
  if (expiresAt !== undefined) out.expiresAt = expiresAt;
  return out;
}

function toOwnership(r: Row): OwnershipRuleRecord {
  const out: OwnershipRuleRecord = {
    id: String(r.id),
    resourceType: String(r.resource_type),
    permissions: json<string[]>(r.permissions),
    system: bool(r.system),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
  const description = optStr(r.description);
  if (description !== undefined) out.description = description;
  return out;
}

function toPolicy(r: Row): PolicyRecord {
  const out: PolicyRecord = {
    id: String(r.id),
    effect: String(r.effect) as Effect,
    permissions: json<string[]>(r.permissions),
    condition: json<PolicyCondition>(r.condition_json),
    system: bool(r.system),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
  const description = optStr(r.description);
  const resourceTypes = optJson<string[]>(r.resource_types);
  const roles = optJson<string[]>(r.roles);
  if (description !== undefined) out.description = description;
  if (resourceTypes !== undefined) out.resourceTypes = resourceTypes;
  if (roles !== undefined) out.roles = roles;
  return out;
}

const ASSIGNMENT_COLUMNS =
  'id, subject_id, role_key, org_id, team_id, created_at, created_by, expires_at';
const GRANT_COLUMNS =
  'id, subject_id, role_key, resource_type, resource_id, org_id, permissions, effect, created_at, created_by, expires_at';

class Where {
  readonly clauses: string[] = [];
  readonly params: unknown[] = [];
  add(sql: (placeholder: string) => string, value: unknown): void {
    this.params.push(value);
    this.clauses.push(sql(`$${this.params.length}`));
  }
  raw(sql: string): void {
    this.clauses.push(sql);
  }
  toSql(): string {
    return this.clauses.length > 0 ? ` WHERE ${this.clauses.join(' AND ')}` : '';
  }
}

function assignmentWhere(filter: AssignmentFilter): Where {
  const w = new Where();
  if (filter.subjectId !== undefined) w.add((p) => `subject_id = ${p}`, filter.subjectId);
  if (filter.roleKey !== undefined) w.add((p) => `role_key = ${p}`, filter.roleKey);
  if (filter.orgId !== undefined) w.add((p) => `org_id = ${p}`, filter.orgId ?? '');
  if (filter.teamId !== undefined) w.add((p) => `team_id = ${p}`, filter.teamId ?? '');
  return w;
}

function grantWhere(filter: GrantFilter): Where {
  const w = new Where();
  if (filter.subjectId !== undefined) w.add((p) => `subject_id = ${p}`, filter.subjectId);
  if (filter.roleKey !== undefined) w.add((p) => `role_key = ${p}`, filter.roleKey);
  if (filter.resourceType !== undefined) w.add((p) => `resource_type = ${p}`, filter.resourceType);
  if (filter.resourceId !== undefined) w.add((p) => `resource_id = ${p}`, filter.resourceId);
  if (filter.orgId !== undefined) w.add((p) => `org_id = ${p}`, filter.orgId ?? '');
  return w;
}

function pageOf<T extends { id: string }>(items: T[], limit: number): Page<T> {
  if (items.length <= limit) return { items };
  const page = items.slice(0, limit);
  const last = page.at(-1);
  return last ? { items: page, nextCursor: last.id } : { items: page };
}

const MAX_ROLE_KEYS_PER_QUERY = 500;

/**
 * RbacStore for PostgreSQL and SQLite over the SqlClient port. Run `migrate(client)` (with the
 * same tablePrefix) before use. Every statement is parameterised.
 */
export function createSqlStore(client: SqlClient, options: SqlStoreOptions = {}): RbacStore {
  const p = checkPrefix(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
  return buildStore(client, p);
}

function buildStore(db: SqlClient, p: string): RbacStore {
  const q = <R = Row>(sql: string, params: readonly unknown[] = []) => db.query<R>(sql, params);
  const js = (value: unknown) => JSON.stringify(value);
  const roleKeysIn = (keys: readonly string[], offset: number) => {
    const list = keys.slice(0, MAX_ROLE_KEYS_PER_QUERY);
    return { sql: list.map((_, i) => `$${offset + i + 1}`).join(', '), params: list };
  };

  const store: RbacStore = {
    async listPermissions() {
      const r = await q(`SELECT * FROM ${p}permissions ORDER BY key`);
      return r.rows.map(toPermission);
    },
    async getPermission(key) {
      const r = await q(`SELECT * FROM ${p}permissions WHERE key = $1`, [key]);
      return r.rows[0] ? toPermission(r.rows[0]) : undefined;
    },
    async putPermission(rec) {
      await q(
        `INSERT INTO ${p}permissions (key, description, system, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key) DO UPDATE SET description = excluded.description,
           system = excluded.system, updated_at = excluded.updated_at`,
        [rec.key, rec.description ?? null, rec.system, rec.createdAt, rec.updatedAt],
      );
    },
    async deletePermission(key) {
      const r = await q(`DELETE FROM ${p}permissions WHERE key = $1`, [key]);
      return r.rowCount > 0;
    },

    async listRoles() {
      const r = await q(`SELECT * FROM ${p}roles ORDER BY key`);
      return r.rows.map(toRole);
    },
    async getRole(key) {
      const r = await q(`SELECT * FROM ${p}roles WHERE key = $1`, [key]);
      return r.rows[0] ? toRole(r.rows[0]) : undefined;
    },
    async insertRole(rec) {
      const r = await q(
        `INSERT INTO ${p}roles (key, name, description, permissions, denies, parents,
           assignable_scopes, system, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (key) DO NOTHING`,
        [
          rec.key,
          rec.name,
          rec.description ?? null,
          js(rec.permissions),
          js(rec.denies),
          js(rec.parents),
          js(rec.assignableScopes),
          rec.system,
          rec.version,
          rec.createdAt,
          rec.updatedAt,
        ],
      );
      return r.rowCount > 0;
    },
    async updateRole(rec, expectedVersion) {
      const r = await q(
        `UPDATE ${p}roles SET name = $2, description = $3, permissions = $4, denies = $5,
           parents = $6, assignable_scopes = $7, system = $8, version = $9, updated_at = $10
         WHERE key = $1 AND version = $11`,
        [
          rec.key,
          rec.name,
          rec.description ?? null,
          js(rec.permissions),
          js(rec.denies),
          js(rec.parents),
          js(rec.assignableScopes),
          rec.system,
          rec.version,
          rec.updatedAt,
          expectedVersion,
        ],
      );
      return r.rowCount > 0;
    },
    async deleteRole(key) {
      const r = await q(`DELETE FROM ${p}roles WHERE key = $1`, [key]);
      return r.rowCount > 0;
    },
    async getRolesRevision() {
      const r = await q<{ value: unknown }>(`SELECT value FROM ${p}meta WHERE key = $1`, [
        'roles_revision',
      ]);
      return r.rows[0] ? num(r.rows[0].value) : 0;
    },
    async bumpRolesRevision(expected) {
      const r = await q(`UPDATE ${p}meta SET value = value + 1 WHERE key = $1 AND value = $2`, [
        'roles_revision',
        expected,
      ]);
      return r.rowCount > 0;
    },

    async listAssignmentsForSubject(subjectId) {
      const r = await q(`SELECT ${ASSIGNMENT_COLUMNS} FROM ${p}assignments WHERE subject_id = $1`, [
        subjectId,
      ]);
      return r.rows.map(toAssignment);
    },
    async listAssignments(filter, page: StorePage) {
      const w = assignmentWhere(filter);
      if (page.cursor !== undefined) w.add((ph) => `id > ${ph}`, page.cursor);
      w.params.push(page.limit + 1);
      const r = await q(
        `SELECT ${ASSIGNMENT_COLUMNS} FROM ${p}assignments${w.toSql()} ORDER BY id LIMIT $${w.params.length}`,
        w.params,
      );
      return pageOf(r.rows.map(toAssignment), page.limit);
    },
    async countAssignments(filter) {
      const w = assignmentWhere(filter);
      const r = await q<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM ${p}assignments${w.toSql()}`,
        w.params,
      );
      return r.rows[0] ? num(r.rows[0].n) : 0;
    },
    async getAssignment(id) {
      const r = await q(`SELECT ${ASSIGNMENT_COLUMNS} FROM ${p}assignments WHERE id = $1`, [id]);
      return r.rows[0] ? toAssignment(r.rows[0]) : undefined;
    },
    async insertAssignment(rec) {
      const r = await q(
        `INSERT INTO ${p}assignments (id, subject_id, role_key, org_id, team_id, created_at,
           created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (subject_id, role_key, org_id, team_id) DO NOTHING`,
        [
          rec.id,
          rec.subjectId,
          rec.roleKey,
          rec.orgId ?? '',
          rec.teamId ?? '',
          rec.createdAt,
          rec.createdBy ?? null,
          rec.expiresAt ?? null,
        ],
      );
      if (r.rowCount > 0) return { record: rec, created: true };
      const existing = await q(
        `SELECT ${ASSIGNMENT_COLUMNS} FROM ${p}assignments
         WHERE subject_id = $1 AND role_key = $2 AND org_id = $3 AND team_id = $4`,
        [rec.subjectId, rec.roleKey, rec.orgId ?? '', rec.teamId ?? ''],
      );
      const row = existing.rows[0];
      return row ? { record: toAssignment(row), created: false } : { record: rec, created: false };
    },
    async deleteAssignment(id) {
      const r = await q(`DELETE FROM ${p}assignments WHERE id = $1`, [id]);
      return r.rowCount > 0;
    },
    async deleteAssignmentsForRole(roleKey) {
      const r = await q(`DELETE FROM ${p}assignments WHERE role_key = $1`, [roleKey]);
      return r.rowCount;
    },

    async findGrants(lookup: GrantLookup) {
      const roles = roleKeysIn(lookup.roleKeys, 3);
      const principal =
        roles.params.length > 0
          ? `(subject_id = $3 OR role_key IN (${roles.sql}))`
          : 'subject_id = $3';
      const r = await q(
        `SELECT ${GRANT_COLUMNS} FROM ${p}grants
         WHERE resource_type = $1 AND resource_id = $2 AND ${principal}`,
        [lookup.resourceType, lookup.resourceId, lookup.subjectId, ...roles.params],
      );
      return r.rows.map(toGrant);
    },
    async listGrantsForPrincipals(lookup: PrincipalGrantLookup) {
      const roles = roleKeysIn(lookup.roleKeys, 1);
      const params: unknown[] = [lookup.subjectId, ...roles.params];
      let sql = `SELECT ${GRANT_COLUMNS} FROM ${p}grants WHERE ${
        roles.params.length > 0
          ? `(subject_id = $1 OR role_key IN (${roles.sql}))`
          : 'subject_id = $1'
      }`;
      if (lookup.resources && lookup.resources.length > 0) {
        const parts: string[] = [];
        for (const res of lookup.resources.slice(0, 200)) {
          params.push(res.type, res.id);
          parts.push(`(resource_type = $${params.length - 1} AND resource_id = $${params.length})`);
        }
        sql += ` AND (${parts.join(' OR ')})`;
      } else if (lookup.resources) {
        return [];
      }
      params.push(lookup.limit);
      sql += ` ORDER BY id LIMIT $${params.length}`;
      const r = await q(sql, params);
      return r.rows.map(toGrant);
    },
    async listGrants(filter, page: StorePage) {
      const w = grantWhere(filter);
      if (page.cursor !== undefined) w.add((ph) => `id > ${ph}`, page.cursor);
      w.params.push(page.limit + 1);
      const r = await q(
        `SELECT ${GRANT_COLUMNS} FROM ${p}grants${w.toSql()} ORDER BY id LIMIT $${w.params.length}`,
        w.params,
      );
      return pageOf(r.rows.map(toGrant), page.limit);
    },
    async countGrants(filter) {
      const w = grantWhere(filter);
      const r = await q<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM ${p}grants${w.toSql()}`,
        w.params,
      );
      return r.rows[0] ? num(r.rows[0].n) : 0;
    },
    async getGrant(id) {
      const r = await q(`SELECT ${GRANT_COLUMNS} FROM ${p}grants WHERE id = $1`, [id]);
      return r.rows[0] ? toGrant(r.rows[0]) : undefined;
    },
    async insertGrant(rec) {
      await q(
        `INSERT INTO ${p}grants (id, subject_id, role_key, resource_type, resource_id, org_id,
           permissions, effect, created_at, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          rec.id,
          rec.subjectId ?? null,
          rec.roleKey ?? null,
          rec.resourceType,
          rec.resourceId,
          rec.orgId ?? '',
          js(rec.permissions),
          rec.effect,
          rec.createdAt,
          rec.createdBy ?? null,
          rec.expiresAt ?? null,
        ],
      );
    },
    async deleteGrant(id) {
      const r = await q(`DELETE FROM ${p}grants WHERE id = $1`, [id]);
      return r.rowCount > 0;
    },
    async deleteGrantsForRole(roleKey) {
      const r = await q(`DELETE FROM ${p}grants WHERE role_key = $1`, [roleKey]);
      return r.rowCount;
    },

    async deleteExpired(now) {
      const a = await q(
        `DELETE FROM ${p}assignments WHERE expires_at IS NOT NULL AND expires_at <= $1`,
        [now],
      );
      const g = await q(
        `DELETE FROM ${p}grants WHERE expires_at IS NOT NULL AND expires_at <= $1`,
        [now],
      );
      return { assignments: a.rowCount, grants: g.rowCount };
    },

    async listOwnershipRules() {
      const r = await q(`SELECT * FROM ${p}ownership_rules ORDER BY id`);
      return r.rows.map(toOwnership);
    },
    async getOwnershipRule(id) {
      const r = await q(`SELECT * FROM ${p}ownership_rules WHERE id = $1`, [id]);
      return r.rows[0] ? toOwnership(r.rows[0]) : undefined;
    },
    async putOwnershipRule(rec) {
      await q(
        `INSERT INTO ${p}ownership_rules (id, resource_type, permissions, description, system,
           created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET resource_type = excluded.resource_type,
           permissions = excluded.permissions, description = excluded.description,
           system = excluded.system, updated_at = excluded.updated_at`,
        [
          rec.id,
          rec.resourceType,
          js(rec.permissions),
          rec.description ?? null,
          rec.system,
          rec.createdAt,
          rec.updatedAt,
        ],
      );
    },
    async deleteOwnershipRule(id) {
      const r = await q(`DELETE FROM ${p}ownership_rules WHERE id = $1`, [id]);
      return r.rowCount > 0;
    },

    async listPolicies() {
      const r = await q(`SELECT * FROM ${p}policies ORDER BY id`);
      return r.rows.map(toPolicy);
    },
    async getPolicy(id) {
      const r = await q(`SELECT * FROM ${p}policies WHERE id = $1`, [id]);
      return r.rows[0] ? toPolicy(r.rows[0]) : undefined;
    },
    async putPolicy(rec) {
      await q(
        `INSERT INTO ${p}policies (id, description, effect, permissions, resource_types, roles,
           condition_json, system, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET description = excluded.description,
           effect = excluded.effect, permissions = excluded.permissions,
           resource_types = excluded.resource_types, roles = excluded.roles,
           condition_json = excluded.condition_json, system = excluded.system,
           updated_at = excluded.updated_at`,
        [
          rec.id,
          rec.description ?? null,
          rec.effect,
          js(rec.permissions),
          rec.resourceTypes === undefined ? null : js(rec.resourceTypes),
          rec.roles === undefined ? null : js(rec.roles),
          js(rec.condition),
          rec.system,
          rec.createdAt,
          rec.updatedAt,
        ],
      );
    },
    async deletePolicy(id) {
      const r = await q(`DELETE FROM ${p}policies WHERE id = $1`, [id]);
      return r.rowCount > 0;
    },

    async transaction<T>(fn: (tx: RbacStore) => Promise<T>): Promise<T> {
      return db.transaction((tx) => fn(buildStore(tx, p)));
    },
  };
  return store;
}
