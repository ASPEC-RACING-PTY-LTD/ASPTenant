import { ApiKeysError } from '../errors.js';
import type { SqlClient } from '../ports.js';
import type { ApiKeysStore } from '../store.js';
import type { ApiKeyRecord, KeyStatus, OwnerType, Page, ServiceAccountRecord } from '../types.js';

export interface Migration {
  id: string;
  postgres: string;
  sqlite: string;
}

export interface SqlApiKeysStoreOptions {
  /** Table name prefix. Default `api_keys_`. Must match `^[a-z][a-z0-9_]{0,40}$`. */
  tablePrefix?: string;
}

const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;

function resolvePrefix(prefix: string | undefined): string {
  const p = prefix ?? 'api_keys_';
  if (!PREFIX_PATTERN.test(p)) {
    throw new ApiKeysError(
      'API_KEYS_INVALID_CONFIG',
      'tablePrefix must match ^[a-z][a-z0-9_]{0,40}$',
      { details: { option: 'tablePrefix' } },
    );
  }
  return p;
}

function initialSchema(p: string, dialect: 'postgres' | 'sqlite'): string {
  const json = dialect === 'postgres' ? 'JSONB' : 'TEXT';
  const big = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  return `
CREATE TABLE IF NOT EXISTS ${p}keys (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL,
  display_prefix TEXT NOT NULL,
  prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes ${json} NOT NULL,
  status TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  org_id TEXT,
  metadata ${json} NOT NULL,
  expires_at ${big},
  revoked_at ${big},
  revoked_reason TEXT,
  revoked_by TEXT,
  previous_key_hash TEXT,
  previous_expires_at ${big},
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL,
  last_used_at ${big},
  last_used_ip TEXT,
  use_count ${big} NOT NULL,
  rate_limit INTEGER,
  rate_limit_window_ms ${big}
);
CREATE INDEX IF NOT EXISTS ${p}keys_owner_idx ON ${p}keys (owner_type, owner_id, created_at);
CREATE INDEX IF NOT EXISTS ${p}keys_status_idx ON ${p}keys (status, created_at);
CREATE INDEX IF NOT EXISTS ${p}keys_org_idx ON ${p}keys (org_id, created_at);
CREATE INDEX IF NOT EXISTS ${p}keys_expires_idx ON ${p}keys (expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS ${p}service_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  org_id TEXT,
  metadata ${json} NOT NULL,
  enabled INTEGER NOT NULL,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL,
  disabled_at ${big}
);
CREATE INDEX IF NOT EXISTS ${p}sa_org_idx ON ${p}service_accounts (org_id, created_at);
CREATE TABLE IF NOT EXISTS ${p}schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at ${big} NOT NULL
);
`;
}

export function createMigrations(prefix = 'api_keys_'): Migration[] {
  const p = resolvePrefix(prefix);
  return [
    {
      id: '001_initial',
      postgres: initialSchema(p, 'postgres'),
      sqlite: initialSchema(p, 'sqlite'),
    },
  ];
}

export const migrations = createMigrations();

export async function migrate(
  client: SqlClient,
  options: SqlApiKeysStoreOptions = {},
): Promise<void> {
  const p = resolvePrefix(options.tablePrefix);
  const list = createMigrations(p);
  const dialect = client.dialect;
  const run = async (tx: SqlClient) => {
    await tx.query(
      `CREATE TABLE IF NOT EXISTS ${p}schema_migrations (id TEXT PRIMARY KEY, applied_at ${
        dialect === 'postgres' ? 'BIGINT' : 'INTEGER'
      } NOT NULL)`,
    );
    for (const m of list) {
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM ${p}schema_migrations WHERE id = $1`,
        [m.id],
      );
      if (existing.rows.length > 0) continue;
      const sql = dialect === 'postgres' ? m.postgres : m.sqlite;
      await tx.query(sql);
      await tx.query(`INSERT INTO ${p}schema_migrations (id, applied_at) VALUES ($1, $2)`, [
        m.id,
        Date.now(),
      ]);
    }
  };
  if (dialect === 'postgres') {
    await client.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(87231405)`);
      await run(tx);
    });
  } else {
    await client.transaction(run);
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function rowToKey(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    keyHash: String(row.key_hash),
    displayPrefix: String(row.display_prefix),
    prefix: String(row.prefix),
    name: String(row.name),
    scopes: parseJson<string[]>(row.scopes, []),
    status: String(row.status) as KeyStatus,
    ownerType: String(row.owner_type) as OwnerType,
    ownerId: String(row.owner_id),
    orgId: row.org_id === null || row.org_id === undefined ? null : String(row.org_id),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    expiresAt:
      row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    revokedAt:
      row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
    revokedReason:
      row.revoked_reason === null || row.revoked_reason === undefined
        ? null
        : String(row.revoked_reason),
    revokedBy:
      row.revoked_by === null || row.revoked_by === undefined ? null : String(row.revoked_by),
    previousKeyHash:
      row.previous_key_hash === null || row.previous_key_hash === undefined
        ? null
        : String(row.previous_key_hash),
    previousExpiresAt:
      row.previous_expires_at === null || row.previous_expires_at === undefined
        ? null
        : Number(row.previous_expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt:
      row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
    lastUsedIp:
      row.last_used_ip === null || row.last_used_ip === undefined ? null : String(row.last_used_ip),
    useCount: Number(row.use_count),
    rateLimit:
      row.rate_limit === null || row.rate_limit === undefined ? null : Number(row.rate_limit),
    rateLimitWindowMs:
      row.rate_limit_window_ms === null || row.rate_limit_window_ms === undefined
        ? null
        : Number(row.rate_limit_window_ms),
  };
}

function rowToSa(row: Record<string, unknown>): ServiceAccountRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description:
      row.description === null || row.description === undefined ? null : String(row.description),
    orgId: row.org_id === null || row.org_id === undefined ? null : String(row.org_id),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    enabled: Number(row.enabled) === 1 || row.enabled === true,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    disabledAt:
      row.disabled_at === null || row.disabled_at === undefined ? null : Number(row.disabled_at),
  };
}

function decodeCursor(cursor: string | undefined): { createdAt: number; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [createdAt, id] = raw.split('\n');
    if (!createdAt || !id) return undefined;
    const n = Number(createdAt);
    if (!Number.isFinite(n)) return undefined;
    return { createdAt: n, id };
  } catch {
    return undefined;
  }
}

function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(`${createdAt}\n${id}`, 'utf8').toString('base64url');
}

function jsonParam(value: unknown, dialect: SqlClient['dialect']): unknown {
  return dialect === 'postgres' ? JSON.stringify(value) : JSON.stringify(value);
}

export function createSqlStore(
  client: SqlClient,
  options: SqlApiKeysStoreOptions = {},
): ApiKeysStore {
  const p = resolvePrefix(options.tablePrefix);
  const dialect = client.dialect;

  return {
    async insertKey(record) {
      try {
        await client.query(
          `INSERT INTO ${p}keys (
            id, public_id, key_hash, display_prefix, prefix, name, scopes, status,
            owner_type, owner_id, org_id, metadata, expires_at, revoked_at, revoked_reason,
            revoked_by, previous_key_hash, previous_expires_at, created_at, updated_at,
            last_used_at, last_used_ip, use_count, rate_limit, rate_limit_window_ms
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
          )`,
          [
            record.id,
            record.publicId,
            record.keyHash,
            record.displayPrefix,
            record.prefix,
            record.name,
            jsonParam(record.scopes, dialect),
            record.status,
            record.ownerType,
            record.ownerId,
            record.orgId,
            jsonParam(record.metadata, dialect),
            record.expiresAt,
            record.revokedAt,
            record.revokedReason,
            record.revokedBy,
            record.previousKeyHash,
            record.previousExpiresAt,
            record.createdAt,
            record.updatedAt,
            record.lastUsedAt,
            record.lastUsedIp,
            record.useCount,
            record.rateLimit,
            record.rateLimitWindowMs,
          ],
        );
      } catch (err) {
        throw new ApiKeysError('API_KEYS_CONFLICT', 'Key already exists', {
          status: 409,
          cause: err,
        });
      }
    },
    async updateKey(record) {
      const result = await client.query(
        `UPDATE ${p}keys SET
          key_hash=$2, display_prefix=$3, prefix=$4, name=$5, scopes=$6, status=$7,
          owner_type=$8, owner_id=$9, org_id=$10, metadata=$11, expires_at=$12, revoked_at=$13,
          revoked_reason=$14, revoked_by=$15, previous_key_hash=$16, previous_expires_at=$17,
          updated_at=$18, last_used_at=$19, last_used_ip=$20, use_count=$21, rate_limit=$22,
          rate_limit_window_ms=$23
        WHERE id=$1`,
        [
          record.id,
          record.keyHash,
          record.displayPrefix,
          record.prefix,
          record.name,
          jsonParam(record.scopes, dialect),
          record.status,
          record.ownerType,
          record.ownerId,
          record.orgId,
          jsonParam(record.metadata, dialect),
          record.expiresAt,
          record.revokedAt,
          record.revokedReason,
          record.revokedBy,
          record.previousKeyHash,
          record.previousExpiresAt,
          record.updatedAt,
          record.lastUsedAt,
          record.lastUsedIp,
          record.useCount,
          record.rateLimit,
          record.rateLimitWindowMs,
        ],
      );
      if (result.rowCount === 0) {
        throw new ApiKeysError('API_KEYS_NOT_FOUND', 'Key not found', { status: 404 });
      }
    },
    async getKeyById(id) {
      const r = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${p}keys WHERE id = $1`,
        [id],
      );
      return r.rows[0] ? rowToKey(r.rows[0]) : undefined;
    },
    async getKeyByPublicId(publicId) {
      const r = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${p}keys WHERE public_id = $1`,
        [publicId],
      );
      return r.rows[0] ? rowToKey(r.rows[0]) : undefined;
    },
    async listKeys(query, now) {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const cursor = decodeCursor(query.cursor);
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (query.status) add('status = ?', query.status);
      if (query.ownerType) add('owner_type = ?', query.ownerType);
      if (query.ownerId) add('owner_id = ?', query.ownerId);
      if (query.orgId) add('org_id = ?', query.orgId);
      if (query.expiringWithinDays !== undefined) {
        const until = now + query.expiringWithinDays * 86_400_000;
        if (!query.status) {
          params.push('active');
          where.push(`status = $${params.length}`);
        }
        params.push(until);
        where.push(`expires_at IS NOT NULL AND expires_at <= $${params.length}`);
      }
      if (query.q) {
        params.push(`%${query.q.toLowerCase()}%`);
        where.push(
          `(LOWER(name) LIKE $${params.length} OR LOWER(public_id) LIKE $${params.length})`,
        );
      }
      if (cursor) {
        params.push(cursor.createdAt, cursor.id);
        where.push(
          `(created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id > $${params.length}))`,
        );
      }
      // Scope filter in SQL is awkward for JSON; filter in memory after fetch when set.
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limit + 1);
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${p}keys ${whereSql} ORDER BY created_at DESC, id ASC LIMIT $${params.length}`,
        params,
      );
      let items = result.rows.map(rowToKey);
      if (query.scope) {
        const scope = query.scope;
        items = items.filter((k) => k.scopes.includes(scope));
      }
      const page = items.slice(0, limit);
      const next =
        items.length > limit
          ? encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id)
          : null;
      return { items: page, nextCursor: next };
    },
    async deleteKey(id) {
      const r = await client.query(`DELETE FROM ${p}keys WHERE id = $1`, [id]);
      return r.rowCount > 0;
    },
    async insertServiceAccount(record) {
      try {
        await client.query(
          `INSERT INTO ${p}service_accounts (
            id, name, description, org_id, metadata, enabled, created_at, updated_at, disabled_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            record.id,
            record.name,
            record.description,
            record.orgId,
            jsonParam(record.metadata, dialect),
            record.enabled ? 1 : 0,
            record.createdAt,
            record.updatedAt,
            record.disabledAt,
          ],
        );
      } catch (err) {
        throw new ApiKeysError('API_KEYS_CONFLICT', 'Service account already exists', {
          status: 409,
          cause: err,
        });
      }
    },
    async updateServiceAccount(record) {
      const r = await client.query(
        `UPDATE ${p}service_accounts SET
          name=$2, description=$3, org_id=$4, metadata=$5, enabled=$6, updated_at=$7, disabled_at=$8
        WHERE id=$1`,
        [
          record.id,
          record.name,
          record.description,
          record.orgId,
          jsonParam(record.metadata, dialect),
          record.enabled ? 1 : 0,
          record.updatedAt,
          record.disabledAt,
        ],
      );
      if (r.rowCount === 0) {
        throw new ApiKeysError('API_KEYS_NOT_FOUND', 'Service account not found', { status: 404 });
      }
    },
    async getServiceAccount(id) {
      const r = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${p}service_accounts WHERE id = $1`,
        [id],
      );
      return r.rows[0] ? rowToSa(r.rows[0]) : undefined;
    },
    async listServiceAccounts(query) {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const cursor = decodeCursor(query.cursor);
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (query.orgId) add('org_id = ?', query.orgId);
      if (query.enabled !== undefined) add('enabled = ?', query.enabled ? 1 : 0);
      if (query.q) {
        params.push(`%${query.q.toLowerCase()}%`);
        where.push(`LOWER(name) LIKE $${params.length}`);
      }
      if (cursor) {
        params.push(cursor.createdAt, cursor.id);
        where.push(
          `(created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id > $${params.length}))`,
        );
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limit + 1);
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${p}service_accounts ${whereSql} ORDER BY created_at DESC, id ASC LIMIT $${params.length}`,
        params,
      );
      const items = result.rows.map(rowToSa);
      const page = items.slice(0, limit);
      const next =
        items.length > limit
          ? encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id)
          : null;
      return { items: page, nextCursor: next };
    },
    async deleteServiceAccount(id) {
      const r = await client.query(`DELETE FROM ${p}service_accounts WHERE id = $1`, [id]);
      return r.rowCount > 0;
    },
    async applyUsage(deltas) {
      for (const d of deltas) {
        await client.query(
          `UPDATE ${p}keys SET
            use_count = use_count + $2,
            last_used_at = CASE WHEN last_used_at IS NULL OR last_used_at < $3 THEN $3 ELSE last_used_at END,
            last_used_ip = CASE WHEN last_used_at IS NULL OR last_used_at < $3 THEN $4 ELSE last_used_ip END,
            updated_at = CASE WHEN updated_at < $3 THEN $3 ELSE updated_at END
          WHERE public_id = $1`,
          [d.publicId, d.increment, d.lastUsedAt, d.lastUsedIp],
        );
      }
    },
    async markExpired(now) {
      const r = await client.query(
        `UPDATE ${p}keys SET status = 'expired', updated_at = $1
         WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= $1`,
        [now],
      );
      return r.rowCount;
    },
  };
}

export type { Page };
