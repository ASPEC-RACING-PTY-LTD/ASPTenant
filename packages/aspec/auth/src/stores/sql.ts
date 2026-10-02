import { AuthError, configError } from '../errors.js';
import type { SqlClient, SqlDialect } from '../ports.js';
import type {
  AccountPatch,
  AccountRecord,
  AuthMethod,
  AuthStore,
  IdentityRecord,
  OneTimeTokenPurpose,
  OneTimeTokenRecord,
  RefreshTokenRecord,
  SessionRecord,
  WebAuthnCredentialRecord,
} from '../store.js';

export type { SqlClient, SqlDialect, SqlQueryResult } from '../ports.js';

export interface Migration {
  id: string;
  postgres: string;
  sqlite: string;
}

export interface SqlAuthStoreOptions {
  /** Table name prefix. Default `auth_`. Validated as an identifier; never user input. */
  tablePrefix?: string;
}

const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;

function checkPrefix(prefix: string): string {
  if (!PREFIX_PATTERN.test(prefix)) configError('tablePrefix', 'must match ^[a-z][a-z0-9_]{0,30}$');
  return prefix;
}

function schema(p: string, d: SqlDialect): string {
  const big = d === 'postgres' ? 'BIGINT' : 'INTEGER';
  const bool = d === 'postgres' ? 'BOOLEAN' : 'INTEGER';
  const jsonType = d === 'postgres' ? 'JSONB' : 'TEXT';
  const f = d === 'postgres' ? 'FALSE' : '0';
  return `
CREATE TABLE IF NOT EXISTS ${p}accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_verified_at ${big},
  password_hash TEXT,
  password_changed_at ${big},
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  last_failed_login_at ${big},
  locked_until ${big},
  lockout_level INTEGER NOT NULL DEFAULT 0,
  disabled_at ${big},
  totp_secret TEXT,
  totp_pending_secret TEXT,
  totp_last_step ${big},
  mfa_enabled_at ${big},
  last_login_at ${big},
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL
);
CREATE TABLE IF NOT EXISTS ${p}sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES ${p}accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at ${big} NOT NULL,
  last_seen_at ${big} NOT NULL,
  expires_at ${big} NOT NULL,
  ip TEXT,
  user_agent TEXT,
  auth_method TEXT NOT NULL,
  mfa_verified ${bool} NOT NULL DEFAULT ${f}
);
CREATE INDEX IF NOT EXISTS ${p}sessions_account_idx ON ${p}sessions (account_id);
CREATE INDEX IF NOT EXISTS ${p}sessions_expires_idx ON ${p}sessions (expires_at);
CREATE TABLE IF NOT EXISTS ${p}refresh_tokens (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES ${p}accounts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at ${big} NOT NULL,
  expires_at ${big} NOT NULL,
  used_at ${big},
  revoked_at ${big}
);
CREATE INDEX IF NOT EXISTS ${p}refresh_tokens_family_idx ON ${p}refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS ${p}refresh_tokens_session_idx ON ${p}refresh_tokens (session_id);
CREATE INDEX IF NOT EXISTS ${p}refresh_tokens_expires_idx ON ${p}refresh_tokens (expires_at);
CREATE TABLE IF NOT EXISTS ${p}one_time_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  account_id TEXT REFERENCES ${p}accounts(id) ON DELETE CASCADE,
  data ${jsonType},
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at ${big} NOT NULL,
  expires_at ${big} NOT NULL,
  used_at ${big}
);
CREATE INDEX IF NOT EXISTS ${p}one_time_tokens_account_idx ON ${p}one_time_tokens (account_id, purpose);
CREATE INDEX IF NOT EXISTS ${p}one_time_tokens_expires_idx ON ${p}one_time_tokens (expires_at);
CREATE TABLE IF NOT EXISTS ${p}recovery_codes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES ${p}accounts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at ${big} NOT NULL,
  used_at ${big},
  UNIQUE (account_id, code_hash)
);
CREATE TABLE IF NOT EXISTS ${p}identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES ${p}accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  created_at ${big} NOT NULL,
  last_login_at ${big},
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS ${p}identities_account_idx ON ${p}identities (account_id);
CREATE TABLE IF NOT EXISTS ${p}webauthn_credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES ${p}accounts(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter ${big} NOT NULL DEFAULT 0,
  transports ${jsonType},
  device_type TEXT NOT NULL,
  backed_up ${bool} NOT NULL DEFAULT ${f},
  name TEXT,
  created_at ${big} NOT NULL,
  last_used_at ${big}
);
CREATE INDEX IF NOT EXISTS ${p}webauthn_credentials_account_idx ON ${p}webauthn_credentials (account_id);
`;
}

/** Migrations for a table prefix. Migration IDs are stable; SQL is idempotent. */
export function createMigrations(tablePrefix = 'auth_'): readonly Migration[] {
  const p = checkPrefix(tablePrefix);
  return [{ id: '0001_initial', postgres: schema(p, 'postgres'), sqlite: schema(p, 'sqlite') }];
}

/** Migrations for the default `auth_` prefix. */
export const migrations: readonly Migration[] = createMigrations('auth_');

/** Tables created by the migrations for a prefix (useful for uninstall scripts). */
export function tableNames(tablePrefix = 'auth_'): string[] {
  const p = checkPrefix(tablePrefix);
  return [
    'accounts',
    'sessions',
    'refresh_tokens',
    'one_time_tokens',
    'recovery_codes',
    'identities',
    'webauthn_credentials',
    'schema_migrations',
  ].map((t) => `${p}${t}`);
}

/**
 * Applies pending migrations idempotently, recording them in `<prefix>schema_migrations`.
 * On PostgreSQL a transaction-scoped advisory lock serialises concurrent runs.
 */
export async function migrate(client: SqlClient, options: SqlAuthStoreOptions = {}): Promise<void> {
  const p = checkPrefix(options.tablePrefix ?? 'auth_');
  const table = `${p}schema_migrations`;
  const big = client.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, applied_at ${big} NOT NULL)`,
  );
  for (const m of createMigrations(p)) {
    await client.transaction(async (tx) => {
      if (tx.dialect === 'postgres') {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [table]);
      }
      const done = await tx.query(`SELECT id FROM ${table} WHERE id = $1`, [m.id]);
      if (done.rows.length > 0) return;
      await tx.query(tx.dialect === 'postgres' ? m.postgres : m.sqlite);
      await tx.query(`INSERT INTO ${table} (id, applied_at) VALUES ($1, $2)`, [m.id, Date.now()]);
    });
  }
}

type Row = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 't' || v === 'true';
const jsonValue = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
};

function toAccount(r: Row): AccountRecord {
  return {
    id: String(r.id),
    email: String(r.email),
    emailVerifiedAt: numOrNull(r.email_verified_at),
    passwordHash: strOrNull(r.password_hash),
    passwordChangedAt: numOrNull(r.password_changed_at),
    failedLoginCount: num(r.failed_login_count),
    lastFailedLoginAt: numOrNull(r.last_failed_login_at),
    lockedUntil: numOrNull(r.locked_until),
    lockoutLevel: num(r.lockout_level),
    disabledAt: numOrNull(r.disabled_at),
    totpSecret: strOrNull(r.totp_secret),
    totpPendingSecret: strOrNull(r.totp_pending_secret),
    totpLastStep: numOrNull(r.totp_last_step),
    mfaEnabledAt: numOrNull(r.mfa_enabled_at),
    lastLoginAt: numOrNull(r.last_login_at),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

function toSession(r: Row): SessionRecord {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    tokenHash: String(r.token_hash),
    createdAt: num(r.created_at),
    lastSeenAt: num(r.last_seen_at),
    expiresAt: num(r.expires_at),
    ip: strOrNull(r.ip),
    userAgent: strOrNull(r.user_agent),
    authMethod: String(r.auth_method) as AuthMethod,
    mfaVerified: bool(r.mfa_verified),
  };
}

function toRefresh(r: Row): RefreshTokenRecord {
  return {
    id: String(r.id),
    familyId: String(r.family_id),
    accountId: String(r.account_id),
    sessionId: String(r.session_id),
    tokenHash: String(r.token_hash),
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
    usedAt: numOrNull(r.used_at),
    revokedAt: numOrNull(r.revoked_at),
  };
}

function toOneTime(r: Row): OneTimeTokenRecord {
  return {
    id: String(r.id),
    tokenHash: String(r.token_hash),
    purpose: String(r.purpose) as OneTimeTokenPurpose,
    accountId: strOrNull(r.account_id),
    data: jsonValue<Record<string, unknown> | null>(r.data, null),
    attempts: num(r.attempts),
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
    usedAt: numOrNull(r.used_at),
  };
}

function toIdentity(r: Row): IdentityRecord {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    provider: String(r.provider),
    subject: String(r.subject),
    email: strOrNull(r.email),
    createdAt: num(r.created_at),
    lastLoginAt: numOrNull(r.last_login_at),
  };
}

function toCredential(r: Row): WebAuthnCredentialRecord {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    publicKey: String(r.public_key),
    counter: num(r.counter),
    transports: jsonValue<string[]>(r.transports, []),
    deviceType: String(r.device_type) === 'multiDevice' ? 'multiDevice' : 'singleDevice',
    backedUp: bool(r.backed_up),
    name: strOrNull(r.name),
    createdAt: num(r.created_at),
    lastUsedAt: numOrNull(r.last_used_at),
  };
}

const ACCOUNT_COLUMNS: Record<keyof AccountPatch, string> = {
  email: 'email',
  emailVerifiedAt: 'email_verified_at',
  passwordHash: 'password_hash',
  passwordChangedAt: 'password_changed_at',
  failedLoginCount: 'failed_login_count',
  lastFailedLoginAt: 'last_failed_login_at',
  lockedUntil: 'locked_until',
  lockoutLevel: 'lockout_level',
  disabledAt: 'disabled_at',
  totpSecret: 'totp_secret',
  totpPendingSecret: 'totp_pending_secret',
  totpLastStep: 'totp_last_step',
  mfaEnabledAt: 'mfa_enabled_at',
  lastLoginAt: 'last_login_at',
  updatedAt: 'updated_at',
};

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return (
    e?.code === '23505' ||
    (typeof e?.message === 'string' && e.message.includes('UNIQUE constraint failed'))
  );
}

const IN_CHUNK = 500;

/**
 * AuthStore over the SqlClient port for PostgreSQL and SQLite. Run `migrate(client)` first.
 */
export function createSqlAuthStore(
  client: SqlClient,
  options: SqlAuthStoreOptions = {},
): AuthStore {
  const p = checkPrefix(options.tablePrefix ?? 'auth_');
  if (client.dialect !== 'postgres' && client.dialect !== 'sqlite')
    configError('client.dialect', 'must be postgres or sqlite');
  const T = {
    accounts: `${p}accounts`,
    sessions: `${p}sessions`,
    refresh: `${p}refresh_tokens`,
    oneTime: `${p}one_time_tokens`,
    recovery: `${p}recovery_codes`,
    identities: `${p}identities`,
    credentials: `${p}webauthn_credentials`,
  };
  const q = <R = Row>(sql: string, params: readonly unknown[] = [], c: SqlClient = client) =>
    c.query<R>(sql, params);
  const first = async <R>(
    sql: string,
    params: readonly unknown[],
    map: (r: Row) => R,
  ): Promise<R | undefined> => {
    const res = await q(sql, params);
    const row = res.rows[0];
    return row ? map(row) : undefined;
  };
  const placeholders = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => `$${start + i}`).join(', ');
  const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

  return {
    async createAccount(a) {
      const res = await q(
        `INSERT INTO ${T.accounts} (id, email, email_verified_at, password_hash, password_changed_at, failed_login_count,
          last_failed_login_at, locked_until, lockout_level, disabled_at, totp_secret, totp_pending_secret, totp_last_step,
          mfa_enabled_at, last_login_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) ON CONFLICT DO NOTHING`,
        [
          a.id,
          a.email,
          a.emailVerifiedAt,
          a.passwordHash,
          a.passwordChangedAt,
          a.failedLoginCount,
          a.lastFailedLoginAt,
          a.lockedUntil,
          a.lockoutLevel,
          a.disabledAt,
          a.totpSecret,
          a.totpPendingSecret,
          a.totpLastStep,
          a.mfaEnabledAt,
          a.lastLoginAt,
          a.createdAt,
          a.updatedAt,
        ],
      );
      return res.rowCount > 0;
    },
    getAccountById: (id) => first(`SELECT * FROM ${T.accounts} WHERE id = $1`, [id], toAccount),
    getAccountByEmail: (email) =>
      first(`SELECT * FROM ${T.accounts} WHERE email = $1`, [email], toAccount),
    async updateAccount(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [key, value] of Object.entries(patch)) {
        const column = ACCOUNT_COLUMNS[key as keyof AccountPatch];
        if (!column || value === undefined) continue;
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length === 0)
        return first(`SELECT * FROM ${T.accounts} WHERE id = $1`, [id], toAccount);
      try {
        return await first(
          `UPDATE ${T.accounts} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
          params,
          toAccount,
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new AuthError('AUTH_EMAIL_TAKEN');
        throw err;
      }
    },
    async incrementFailedLogins(id, at) {
      const res = await q<{ failed_login_count: unknown }>(
        `UPDATE ${T.accounts} SET failed_login_count = failed_login_count + 1, last_failed_login_at = $2, updated_at = $2
         WHERE id = $1 RETURNING failed_login_count`,
        [id, at],
      );
      const row = res.rows[0];
      return row ? num(row.failed_login_count) : 0;
    },
    async advanceTotpStep(id, step) {
      const res = await q(
        `UPDATE ${T.accounts} SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
        [id, step],
      );
      return res.rowCount > 0;
    },
    async deleteAccount(id) {
      return client.transaction(async (tx) => {
        for (const table of [
          T.sessions,
          T.refresh,
          T.oneTime,
          T.recovery,
          T.identities,
          T.credentials,
        ]) {
          await q(`DELETE FROM ${table} WHERE account_id = $1`, [id], tx);
        }
        const res = await q(`DELETE FROM ${T.accounts} WHERE id = $1`, [id], tx);
        return res.rowCount > 0;
      });
    },

    async createSession(s) {
      await q(
        `INSERT INTO ${T.sessions} (id, account_id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent, auth_method, mfa_verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          s.id,
          s.accountId,
          s.tokenHash,
          s.createdAt,
          s.lastSeenAt,
          s.expiresAt,
          s.ip,
          s.userAgent,
          s.authMethod,
          s.mfaVerified,
        ],
      );
    },
    getSessionByTokenHash: (hash) =>
      first(`SELECT * FROM ${T.sessions} WHERE token_hash = $1`, [hash], toSession),
    getSession: (id) => first(`SELECT * FROM ${T.sessions} WHERE id = $1`, [id], toSession),
    async touchSession(id, lastSeenAt, ip) {
      if (ip === null) {
        await q(`UPDATE ${T.sessions} SET last_seen_at = $2 WHERE id = $1`, [id, lastSeenAt]);
      } else {
        await q(`UPDATE ${T.sessions} SET last_seen_at = $2, ip = $3 WHERE id = $1`, [
          id,
          lastSeenAt,
          ip,
        ]);
      }
    },
    async listSessions(accountId) {
      const res = await q(
        `SELECT * FROM ${T.sessions} WHERE account_id = $1 ORDER BY last_seen_at DESC`,
        [accountId],
      );
      return res.rows.map(toSession);
    },
    async deleteSession(id) {
      const res = await q(`DELETE FROM ${T.sessions} WHERE id = $1`, [id]);
      return res.rowCount > 0;
    },
    async deleteSessionsByAccount(accountId, exceptSessionId) {
      const res =
        exceptSessionId === undefined
          ? await q<{ id: unknown }>(
              `DELETE FROM ${T.sessions} WHERE account_id = $1 RETURNING id`,
              [accountId],
            )
          : await q<{ id: unknown }>(
              `DELETE FROM ${T.sessions} WHERE account_id = $1 AND id <> $2 RETURNING id`,
              [accountId, exceptSessionId],
            );
      return res.rows.map((r) => String(r.id));
    },

    async createRefreshToken(t) {
      await q(
        `INSERT INTO ${T.refresh} (id, family_id, account_id, session_id, token_hash, created_at, expires_at, used_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          t.id,
          t.familyId,
          t.accountId,
          t.sessionId,
          t.tokenHash,
          t.createdAt,
          t.expiresAt,
          t.usedAt,
          t.revokedAt,
        ],
      );
    },
    getRefreshTokenByHash: (hash) =>
      first(`SELECT * FROM ${T.refresh} WHERE token_hash = $1`, [hash], toRefresh),
    async markRefreshTokenUsed(id, at) {
      const res = await q(
        `UPDATE ${T.refresh} SET used_at = $2 WHERE id = $1 AND used_at IS NULL`,
        [id, at],
      );
      return res.rowCount > 0;
    },
    async revokeRefreshFamily(familyId, at) {
      const res = await q(
        `UPDATE ${T.refresh} SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL`,
        [familyId, at],
      );
      return res.rowCount;
    },
    async revokeRefreshTokensBySessions(sessionIds, at) {
      let total = 0;
      for (let i = 0; i < sessionIds.length; i += IN_CHUNK) {
        const chunk = sessionIds.slice(i, i + IN_CHUNK);
        const res = await q(
          `UPDATE ${T.refresh} SET revoked_at = $1 WHERE revoked_at IS NULL AND session_id IN (${placeholders(2, chunk.length)})`,
          [at, ...chunk],
        );
        total += res.rowCount;
      }
      return total;
    },

    async createOneTimeToken(t) {
      await q(
        `INSERT INTO ${T.oneTime} (id, token_hash, purpose, account_id, data, attempts, created_at, expires_at, used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          t.id,
          t.tokenHash,
          t.purpose,
          t.accountId,
          json(t.data),
          t.attempts,
          t.createdAt,
          t.expiresAt,
          t.usedAt,
        ],
      );
    },
    getOneTimeToken: (hash, purpose) =>
      first(
        `SELECT * FROM ${T.oneTime} WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL`,
        [hash, purpose],
        toOneTime,
      ),
    consumeOneTimeToken: (hash, purpose, now) =>
      first(
        `UPDATE ${T.oneTime} SET used_at = $3
         WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3 RETURNING *`,
        [hash, purpose, now],
        toOneTime,
      ),
    async incrementOneTimeTokenAttempts(id) {
      const res = await q<{ attempts: unknown }>(
        `UPDATE ${T.oneTime} SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
        [id],
      );
      const row = res.rows[0];
      return row ? num(row.attempts) : Number.MAX_SAFE_INTEGER;
    },
    async deleteOneTimeTokens(accountId, purpose) {
      const res = await q(
        `DELETE FROM ${T.oneTime} WHERE account_id = $1 AND purpose = $2 AND used_at IS NULL`,
        [accountId, purpose],
      );
      return res.rowCount;
    },
    async getLatestOneTimeTokenCreatedAt(accountId, purpose) {
      const res = await q<{ latest: unknown }>(
        `SELECT MAX(created_at) AS latest FROM ${T.oneTime} WHERE account_id = $1 AND purpose = $2`,
        [accountId, purpose],
      );
      const latest = res.rows[0]?.latest;
      return latest === null || latest === undefined ? undefined : num(latest);
    },

    async replaceRecoveryCodes(accountId, codes) {
      await client.transaction(async (tx) => {
        await q(`DELETE FROM ${T.recovery} WHERE account_id = $1`, [accountId], tx);
        for (const c of codes) {
          await q(
            `INSERT INTO ${T.recovery} (id, account_id, code_hash, created_at, used_at) VALUES ($1, $2, $3, $4, $5)`,
            [c.id, c.accountId, c.codeHash, c.createdAt, c.usedAt],
            tx,
          );
        }
      });
    },
    async consumeRecoveryCode(accountId, codeHash, at) {
      const res = await q(
        `UPDATE ${T.recovery} SET used_at = $3 WHERE account_id = $1 AND code_hash = $2 AND used_at IS NULL`,
        [accountId, codeHash, at],
      );
      return res.rowCount > 0;
    },
    async countUnusedRecoveryCodes(accountId) {
      const res = await q<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM ${T.recovery} WHERE account_id = $1 AND used_at IS NULL`,
        [accountId],
      );
      return num(res.rows[0]?.n ?? 0);
    },

    async createIdentity(i) {
      const res = await q(
        `INSERT INTO ${T.identities} (id, account_id, provider, subject, email, created_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [i.id, i.accountId, i.provider, i.subject, i.email, i.createdAt, i.lastLoginAt],
      );
      return res.rowCount > 0;
    },
    getIdentity: (provider, subject) =>
      first(
        `SELECT * FROM ${T.identities} WHERE provider = $1 AND subject = $2`,
        [provider, subject],
        toIdentity,
      ),
    async listIdentities(accountId) {
      const res = await q(
        `SELECT * FROM ${T.identities} WHERE account_id = $1 ORDER BY created_at`,
        [accountId],
      );
      return res.rows.map(toIdentity);
    },
    async touchIdentity(id, lastLoginAt, email) {
      if (email === null) {
        await q(`UPDATE ${T.identities} SET last_login_at = $2 WHERE id = $1`, [id, lastLoginAt]);
      } else {
        await q(`UPDATE ${T.identities} SET last_login_at = $2, email = $3 WHERE id = $1`, [
          id,
          lastLoginAt,
          email,
        ]);
      }
    },
    async deleteIdentity(accountId, provider, subject) {
      const res = await q(
        `DELETE FROM ${T.identities} WHERE account_id = $1 AND provider = $2 AND subject = $3`,
        [accountId, provider, subject],
      );
      return res.rowCount > 0;
    },

    async createWebAuthnCredential(c) {
      const res = await q(
        `INSERT INTO ${T.credentials} (id, account_id, public_key, counter, transports, device_type, backed_up, name, created_at, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
        [
          c.id,
          c.accountId,
          c.publicKey,
          c.counter,
          json(c.transports),
          c.deviceType,
          c.backedUp,
          c.name,
          c.createdAt,
          c.lastUsedAt,
        ],
      );
      return res.rowCount > 0;
    },
    getWebAuthnCredential: (id) =>
      first(`SELECT * FROM ${T.credentials} WHERE id = $1`, [id], toCredential),
    async listWebAuthnCredentials(accountId) {
      const res = await q(
        `SELECT * FROM ${T.credentials} WHERE account_id = $1 ORDER BY created_at`,
        [accountId],
      );
      return res.rows.map(toCredential);
    },
    async updateWebAuthnCredentialUsage(id, counter, lastUsedAt, backedUp) {
      await q(
        `UPDATE ${T.credentials} SET counter = $2, last_used_at = $3, backed_up = $4 WHERE id = $1`,
        [id, counter, lastUsedAt, backedUp],
      );
    },
    async deleteWebAuthnCredential(accountId, id) {
      const res = await q(`DELETE FROM ${T.credentials} WHERE account_id = $1 AND id = $2`, [
        accountId,
        id,
      ]);
      return res.rowCount > 0;
    },

    async purgeExpired(now) {
      let total = 0;
      total += (await q(`DELETE FROM ${T.sessions} WHERE expires_at <= $1`, [now])).rowCount;
      total += (await q(`DELETE FROM ${T.refresh} WHERE expires_at <= $1`, [now])).rowCount;
      total += (
        await q(`DELETE FROM ${T.oneTime} WHERE expires_at <= $1 OR used_at IS NOT NULL`, [now])
      ).rowCount;
      return total;
    },
  };
}
