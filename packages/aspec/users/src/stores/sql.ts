import { UsersError } from '../errors.js';
import type { SqlClient } from '../ports.js';
import { searchText, type UsersStore } from '../store.js';
import type {
  ActivationTokenRecord,
  ActivityEvent,
  InvitationRecord,
  InvitationStatus,
  User,
  UserStatus,
} from '../types.js';

export interface Migration {
  id: string;
  postgres: string;
  sqlite: string;
}

export interface SqlUsersStoreOptions {
  /** Table name prefix. Default `users_`. Must match `^[a-z][a-z0-9_]{0,40}$`. */
  tablePrefix?: string;
}

const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;

function resolvePrefix(prefix: string | undefined): string {
  const p = prefix ?? 'users_';
  if (!PREFIX_PATTERN.test(p)) {
    throw new UsersError(
      'USERS_CONFIG_INVALID',
      'tablePrefix must match ^[a-z][a-z0-9_]{0,40}$ (lowercase letters, digits, underscores)',
    );
  }
  return p;
}

function initialSchema(p: string, dialect: 'postgres' | 'sqlite'): string {
  const json = dialect === 'postgres' ? 'JSONB' : 'TEXT';
  const big = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  return `
CREATE TABLE IF NOT EXISTS ${p}accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  auth_provider TEXT,
  profile ${json} NOT NULL,
  settings ${json} NOT NULL,
  preferences ${json} NOT NULL,
  metadata ${json} NOT NULL,
  suspension ${json},
  deletion ${json},
  suspended_until ${big},
  purge_after ${big},
  search_text TEXT NOT NULL,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL,
  activated_at ${big},
  last_login_at ${big},
  purged_at ${big},
  version INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${p}accounts_email_uq ON ${p}accounts (email);
CREATE UNIQUE INDEX IF NOT EXISTS ${p}accounts_external_uq ON ${p}accounts (auth_provider, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${p}accounts_created_idx ON ${p}accounts (created_at, id);
CREATE INDEX IF NOT EXISTS ${p}accounts_status_idx ON ${p}accounts (status, created_at);
CREATE INDEX IF NOT EXISTS ${p}accounts_purge_idx ON ${p}accounts (purge_after) WHERE purge_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${p}accounts_suspended_idx ON ${p}accounts (suspended_until) WHERE suspended_until IS NOT NULL;
CREATE TABLE IF NOT EXISTS ${p}activation_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at ${big} NOT NULL,
  expires_at ${big} NOT NULL,
  used_at ${big}
);
CREATE INDEX IF NOT EXISTS ${p}activation_tokens_user_idx ON ${p}activation_tokens (user_id);
CREATE TABLE IF NOT EXISTS ${p}invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  roles ${json} NOT NULL,
  metadata ${json} NOT NULL,
  invited_by TEXT,
  user_id TEXT,
  token_hash TEXT NOT NULL,
  expires_at ${big} NOT NULL,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL,
  last_sent_at ${big},
  send_count INTEGER NOT NULL,
  accepted_at ${big},
  revoked_at ${big},
  version INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${p}invitations_pending_uq ON ${p}invitations (email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ${p}invitations_created_idx ON ${p}invitations (created_at, id);
CREATE TABLE IF NOT EXISTS ${p}activity (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at ${big} NOT NULL,
  actor_id TEXT,
  ip TEXT,
  user_agent TEXT,
  metadata ${json} NOT NULL
);
CREATE INDEX IF NOT EXISTS ${p}activity_user_idx ON ${p}activity (user_id, at, id);
CREATE INDEX IF NOT EXISTS ${p}activity_at_idx ON ${p}activity (at);
`;
}

/** Migrations for a given table prefix. */
export function createMigrations(tablePrefix?: string): readonly Migration[] {
  const p = resolvePrefix(tablePrefix);
  return [
    {
      id: '0001_initial',
      postgres: initialSchema(p, 'postgres'),
      sqlite: initialSchema(p, 'sqlite'),
    },
  ];
}

/** Migrations with the default `users_` prefix. */
export const migrations: readonly Migration[] = createMigrations();

/**
 * Applies pending migrations idempotently, tracked in `<prefix>schema_migrations`.
 * On PostgreSQL a transaction-scoped advisory lock serialises concurrent migrators.
 */
export async function migrate(
  client: SqlClient,
  options: SqlUsersStoreOptions = {},
): Promise<void> {
  const p = resolvePrefix(options.tablePrefix);
  const big = client.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${p}schema_migrations (id TEXT PRIMARY KEY, applied_at ${big} NOT NULL)`,
  );
  for (const m of createMigrations(p)) {
    await client.transaction(async (tx) => {
      if (tx.dialect === 'postgres') {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${p}schema_migrations`]);
      }
      const done = await tx.query(`SELECT id FROM ${p}schema_migrations WHERE id = $1`, [m.id]);
      if (done.rows.length > 0) return;
      await tx.query(tx.dialect === 'postgres' ? m.postgres : m.sqlite);
      await tx.query(`INSERT INTO ${p}schema_migrations (id, applied_at) VALUES ($1, $2)`, [
        m.id,
        Date.now(),
      ]);
    });
  }
}

type Row = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const parseJson = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));
const parseJsonOrNull = <T>(v: unknown): T | null =>
  v === null || v === undefined ? null : parseJson<T>(v);
const json = (v: unknown): string | null => (v === null ? null : JSON.stringify(v));

function toUser(r: Row): User {
  return {
    id: String(r.id),
    email: String(r.email),
    status: String(r.status) as UserStatus,
    externalId: strOrNull(r.external_id),
    authProvider: strOrNull(r.auth_provider),
    profile: parseJson(r.profile),
    settings: parseJson(r.settings),
    preferences: parseJson(r.preferences),
    metadata: parseJson(r.metadata),
    suspension: parseJsonOrNull(r.suspension),
    deletion: parseJsonOrNull(r.deletion),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    activatedAt: numOrNull(r.activated_at),
    lastLoginAt: numOrNull(r.last_login_at),
    purgedAt: numOrNull(r.purged_at),
    version: num(r.version),
  };
}

function toToken(r: Row): ActivationTokenRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    tokenHash: String(r.token_hash),
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
    usedAt: numOrNull(r.used_at),
  };
}

function toInvitation(r: Row): InvitationRecord {
  return {
    id: String(r.id),
    email: String(r.email),
    status: String(r.status) as InvitationStatus,
    roles: parseJson(r.roles),
    metadata: parseJson(r.metadata),
    invitedBy: strOrNull(r.invited_by),
    userId: strOrNull(r.user_id),
    tokenHash: String(r.token_hash),
    expiresAt: num(r.expires_at),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    lastSentAt: numOrNull(r.last_sent_at),
    sendCount: num(r.send_count),
    acceptedAt: numOrNull(r.accepted_at),
    revokedAt: numOrNull(r.revoked_at),
    version: num(r.version),
  };
}

function toActivity(r: Row): ActivityEvent {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    type: String(r.type),
    at: num(r.at),
    actorId: strOrNull(r.actor_id),
    ip: strOrNull(r.ip),
    userAgent: strOrNull(r.user_agent),
    metadata: parseJson(r.metadata),
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown; errcode?: unknown };
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('UNIQUE constraint failed');
}

function uniqueText(err: unknown): string {
  const e = err as { constraint?: unknown; message?: unknown };
  return `${typeof e.constraint === 'string' ? e.constraint : ''} ${typeof e.message === 'string' ? e.message : ''}`;
}

function mapAccountConflict(err: unknown): never {
  if (isUniqueViolation(err)) {
    const text = uniqueText(err);
    if (/accounts_email_uq|accounts\.email/.test(text)) {
      throw new UsersError('USERS_EMAIL_TAKEN', 'A user with this email already exists');
    }
    if (/accounts_external_uq|accounts\.auth_provider/.test(text)) {
      throw new UsersError(
        'USERS_EXTERNAL_ID_TAKEN',
        'This external identity is linked to another user',
      );
    }
    throw new UsersError('USERS_ID_TAKEN', 'User ID already exists');
  }
  throw err;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const ACCOUNT_COLUMNS =
  'id, email, status, external_id, auth_provider, profile, settings, preferences, metadata, suspension, deletion, suspended_until, purge_after, search_text, created_at, updated_at, activated_at, last_login_at, purged_at, version';

function accountParams(u: User): unknown[] {
  return [
    u.id,
    u.email,
    u.status,
    u.externalId,
    u.authProvider,
    json(u.profile),
    json(u.settings),
    json(u.preferences),
    json(u.metadata),
    json(u.suspension),
    json(u.deletion),
    u.status === 'suspended' ? (u.suspension?.until ?? null) : null,
    u.status === 'deleted' && u.purgedAt === null ? (u.deletion?.purgeAfter ?? null) : null,
    searchText(u),
    u.createdAt,
    u.updatedAt,
    u.activatedAt,
    u.lastLoginAt,
    u.purgedAt,
    u.version,
  ];
}

/**
 * SQL store for PostgreSQL and SQLite built on the SqlClient port. Run `migrate(client)`
 * (with the same `tablePrefix`) before use.
 */
export function createSqlUsersStore(
  client: SqlClient,
  options: SqlUsersStoreOptions = {},
): UsersStore {
  const p = resolvePrefix(options.tablePrefix);
  const t = {
    accounts: `${p}accounts`,
    tokens: `${p}activation_tokens`,
    invitations: `${p}invitations`,
    activity: `${p}activity`,
  };

  const one = async <T>(sql: string, params: unknown[], map: (r: Row) => T): Promise<T | null> => {
    const r = await client.query<Row>(sql, params);
    const row = r.rows[0];
    return row ? map(row) : null;
  };

  return {
    async insertUser(user) {
      const placeholders = ACCOUNT_COLUMNS.split(', ')
        .map((_, i) => `$${i + 1}`)
        .join(', ');
      try {
        await client.query(
          `INSERT INTO ${t.accounts} (${ACCOUNT_COLUMNS}) VALUES (${placeholders})`,
          accountParams(user),
        );
      } catch (err) {
        mapAccountConflict(err);
      }
    },
    getUser(id) {
      return one(`SELECT * FROM ${t.accounts} WHERE id = $1`, [id], toUser);
    },
    getUserByEmail(email) {
      return one(`SELECT * FROM ${t.accounts} WHERE email = $1`, [email], toUser);
    },
    getUserByExternalId(provider, externalId) {
      return one(
        `SELECT * FROM ${t.accounts} WHERE auth_provider = $1 AND external_id = $2`,
        [provider, externalId],
        toUser,
      );
    },
    async updateUser(user, expectedVersion) {
      const cols = ACCOUNT_COLUMNS.split(', ').slice(1);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      try {
        const r = await client.query(
          `UPDATE ${t.accounts} SET ${sets} WHERE id = $1 AND version = $${cols.length + 2}`,
          [...accountParams(user), expectedVersion],
        );
        return r.rowCount === 1;
      } catch (err) {
        mapAccountConflict(err);
      }
    },
    async deleteUser(id) {
      return client.transaction(async (tx) => {
        await tx.query(`DELETE FROM ${t.tokens} WHERE user_id = $1`, [id]);
        await tx.query(`DELETE FROM ${t.activity} WHERE user_id = $1`, [id]);
        const r = await tx.query(`DELETE FROM ${t.accounts} WHERE id = $1`, [id]);
        return r.rowCount > 0;
      });
    },
    async listUsers(query) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status) {
        params.push(query.status);
        where.push(`status = $${params.length}`);
      }
      if (query.search) {
        params.push(`%${escapeLike(query.search)}%`);
        where.push(`search_text LIKE $${params.length} ESCAPE '\\'`);
      }
      if (query.after) {
        params.push(query.after.createdAt, query.after.id);
        const a = params.length - 1;
        where.push(`(created_at > $${a} OR (created_at = $${a} AND id > $${a + 1}))`);
      }
      params.push(query.limit);
      const r = await client.query<Row>(
        `SELECT * FROM ${t.accounts}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
        params,
      );
      return r.rows.map(toUser);
    },
    async listDueForPurge(now, limit) {
      const r = await client.query<Row>(
        `SELECT * FROM ${t.accounts} WHERE status = 'deleted' AND purged_at IS NULL AND purge_after IS NOT NULL AND purge_after <= $1 ORDER BY created_at ASC, id ASC LIMIT $2`,
        [now, limit],
      );
      return r.rows.map(toUser);
    },
    async listExpiredSuspensions(now, limit) {
      const r = await client.query<Row>(
        `SELECT * FROM ${t.accounts} WHERE status = 'suspended' AND suspended_until IS NOT NULL AND suspended_until <= $1 ORDER BY created_at ASC, id ASC LIMIT $2`,
        [now, limit],
      );
      return r.rows.map(toUser);
    },

    async insertActivationToken(rec) {
      await client.query(
        `INSERT INTO ${t.tokens} (id, user_id, token_hash, created_at, expires_at, used_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [rec.id, rec.userId, rec.tokenHash, rec.createdAt, rec.expiresAt, rec.usedAt],
      );
    },
    getActivationToken(id) {
      return one(`SELECT * FROM ${t.tokens} WHERE id = $1`, [id], toToken);
    },
    async markActivationTokenUsed(id, usedAt) {
      const r = await client.query(
        `UPDATE ${t.tokens} SET used_at = $2 WHERE id = $1 AND used_at IS NULL`,
        [id, usedAt],
      );
      return r.rowCount === 1;
    },
    async listActivationTokens(userId) {
      const r = await client.query<Row>(
        `SELECT * FROM ${t.tokens} WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
        [userId],
      );
      return r.rows.map(toToken);
    },
    async deleteActivationTokens(userId) {
      await client.query(`DELETE FROM ${t.tokens} WHERE user_id = $1`, [userId]);
    },

    async insertInvitation(rec) {
      try {
        await client.query(
          `INSERT INTO ${t.invitations} (id, email, status, roles, metadata, invited_by, user_id, token_hash, expires_at, created_at, updated_at, last_sent_at, send_count, accepted_at, revoked_at, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            rec.id,
            rec.email,
            rec.status,
            json(rec.roles),
            json(rec.metadata),
            rec.invitedBy,
            rec.userId,
            rec.tokenHash,
            rec.expiresAt,
            rec.createdAt,
            rec.updatedAt,
            rec.lastSentAt,
            rec.sendCount,
            rec.acceptedAt,
            rec.revokedAt,
            rec.version,
          ],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new UsersError(
            'USERS_INVITATION_EXISTS',
            'A pending invitation exists for this email',
          );
        }
        throw err;
      }
    },
    getInvitation(id) {
      return one(`SELECT * FROM ${t.invitations} WHERE id = $1`, [id], toInvitation);
    },
    findPendingInvitation(email) {
      return one(
        `SELECT * FROM ${t.invitations} WHERE email = $1 AND status = 'pending'`,
        [email],
        toInvitation,
      );
    },
    async updateInvitation(rec, expectedVersion) {
      const r = await client.query(
        `UPDATE ${t.invitations} SET status = $2, roles = $3, metadata = $4, user_id = $5, token_hash = $6, expires_at = $7, updated_at = $8, last_sent_at = $9, send_count = $10, accepted_at = $11, revoked_at = $12, version = $13 WHERE id = $1 AND version = $14`,
        [
          rec.id,
          rec.status,
          json(rec.roles),
          json(rec.metadata),
          rec.userId,
          rec.tokenHash,
          rec.expiresAt,
          rec.updatedAt,
          rec.lastSentAt,
          rec.sendCount,
          rec.acceptedAt,
          rec.revokedAt,
          rec.version,
          expectedVersion,
        ],
      );
      return r.rowCount === 1;
    },
    async listInvitations(query) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status) {
        params.push(query.status);
        where.push(`status = $${params.length}`);
      }
      if (query.email) {
        params.push(query.email);
        where.push(`email = $${params.length}`);
      }
      if (query.after) {
        params.push(query.after.createdAt, query.after.id);
        const a = params.length - 1;
        where.push(`(created_at > $${a} OR (created_at = $${a} AND id > $${a + 1}))`);
      }
      params.push(query.limit);
      const r = await client.query<Row>(
        `SELECT * FROM ${t.invitations}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
        params,
      );
      return r.rows.map(toInvitation);
    },
    async deleteInvitationsByEmail(email) {
      const r = await client.query(`DELETE FROM ${t.invitations} WHERE email = $1`, [email]);
      return r.rowCount;
    },

    async appendActivity(e) {
      await client.query(
        `INSERT INTO ${t.activity} (id, user_id, type, at, actor_id, ip, user_agent, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [e.id, e.userId, e.type, e.at, e.actorId, e.ip, e.userAgent, json(e.metadata)],
      );
    },
    async listActivity(userId, query) {
      const params: unknown[] = [userId];
      const where = ['user_id = $1'];
      if (query.type) {
        params.push(query.type);
        where.push(`type = $${params.length}`);
      }
      if (query.before) {
        params.push(query.before.at, query.before.id);
        const a = params.length - 1;
        where.push(`(at < $${a} OR (at = $${a} AND id < $${a + 1}))`);
      }
      params.push(query.limit);
      const r = await client.query<Row>(
        `SELECT * FROM ${t.activity} WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return r.rows.map(toActivity);
    },
    async pruneActivity(before) {
      const r = await client.query(`DELETE FROM ${t.activity} WHERE at < $1`, [before]);
      return r.rowCount;
    },
    async deleteActivity(userId) {
      const r = await client.query(`DELETE FROM ${t.activity} WHERE user_id = $1`, [userId]);
      return r.rowCount;
    },
  };
}
