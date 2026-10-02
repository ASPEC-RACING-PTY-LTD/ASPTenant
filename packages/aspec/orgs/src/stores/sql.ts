import { OrgsError } from '../errors.js';
import type { SqlClient } from '../ports.js';
import type { OrgsStore } from '../store.js';
import type {
  InvitationRecord,
  Membership,
  Organisation,
  Team,
  TeamMembership,
  TenantRecord,
} from '../types.js';

export interface Migration {
  id: string;
  postgres: string;
  sqlite: string;
}

export interface SqlOrgsStoreOptions {
  /** Table name prefix. Default `orgs_`. Must match `^[a-z][a-z0-9_]{0,40}$`. */
  tablePrefix?: string;
}

const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;

function resolvePrefix(prefix: string | undefined): string {
  const p = prefix ?? 'orgs_';
  if (!PREFIX_PATTERN.test(p)) {
    throw new OrgsError(
      'ORGS_CONFIG_INVALID',
      'tablePrefix must match ^[a-z][a-z0-9_]{0,40}$ (lowercase letters, digits, underscores)',
    );
  }
  return p;
}

function initialSchema(p: string, dialect: 'postgres' | 'sqlite'): string {
  const json = dialect === 'postgres' ? 'JSONB' : 'TEXT';
  const big = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  return `
CREATE TABLE IF NOT EXISTS ${p}organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata ${json} NOT NULL,
  settings ${json} NOT NULL,
  created_by TEXT NOT NULL,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL,
  archived_at ${big},
  deleted_at ${big},
  version INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${p}organisations_slug_uq ON ${p}organisations (slug);
CREATE INDEX IF NOT EXISTS ${p}organisations_created_idx ON ${p}organisations (created_at, id);
CREATE TABLE IF NOT EXISTS ${p}memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  invited_at ${big},
  joined_at ${big},
  suspended_at ${big},
  removed_at ${big},
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL,
  version INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${p}memberships_org_user_uq ON ${p}memberships (org_id, user_id);
CREATE INDEX IF NOT EXISTS ${p}memberships_org_idx ON ${p}memberships (org_id, created_at, id);
CREATE INDEX IF NOT EXISTS ${p}memberships_user_idx ON ${p}memberships (user_id);
CREATE TABLE IF NOT EXISTS ${p}teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  metadata ${json} NOT NULL,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL,
  archived_at ${big},
  version INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${p}teams_org_slug_uq ON ${p}teams (org_id, slug);
CREATE INDEX IF NOT EXISTS ${p}teams_org_idx ON ${p}teams (org_id);
CREATE TABLE IF NOT EXISTS ${p}team_memberships (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${p}team_memberships_uq ON ${p}team_memberships (team_id, user_id);
CREATE INDEX IF NOT EXISTS ${p}team_memberships_user_idx ON ${p}team_memberships (org_id, user_id);
CREATE TABLE IF NOT EXISTS ${p}invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  team_ids ${json} NOT NULL,
  status TEXT NOT NULL,
  invited_by TEXT,
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
CREATE UNIQUE INDEX IF NOT EXISTS ${p}invitations_pending_uq ON ${p}invitations (org_id, email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ${p}invitations_org_idx ON ${p}invitations (org_id, created_at, id);
CREATE TABLE IF NOT EXISTS ${p}tenants (
  org_id TEXT PRIMARY KEY,
  strategy TEXT NOT NULL,
  handle TEXT,
  provisioned_at ${big} NOT NULL,
  deprovisioned_at ${big},
  metadata ${json} NOT NULL
);
`;
}

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

export const migrations: readonly Migration[] = createMigrations();

export async function migrate(client: SqlClient, options: SqlOrgsStoreOptions = {}): Promise<void> {
  const p = resolvePrefix(options.tablePrefix);
  const big = client.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${p}schema_migrations (id TEXT PRIMARY KEY, applied_at ${big} NOT NULL)`,
  );
  for (const m of createMigrations(p)) {
    await client.transaction(async (tx) => {
      if (tx.dialect === 'postgres') {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${p}${m.id}`]);
      }
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM ${p}schema_migrations WHERE id = $1`,
        [m.id],
      );
      if (existing.rows.length) return;
      const sql = tx.dialect === 'postgres' ? m.postgres : m.sqlite;
      await tx.query(sql);
      await tx.query(`INSERT INTO ${p}schema_migrations (id, applied_at) VALUES ($1, $2)`, [
        m.id,
        Date.now(),
      ]);
    });
  }
}

type Row = Record<string, unknown>;

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (v === null || v === undefined) return 0;
  return Number(v);
}

function numNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return num(v);
}

function jsonParse(v: unknown): unknown {
  if (typeof v === 'string') return JSON.parse(v) as unknown;
  return v;
}

function json(v: unknown): string {
  return JSON.stringify(v ?? {});
}

function toOrg(r: Row): Organisation {
  return {
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    status: r.status as Organisation['status'],
    metadata: jsonParse(r.metadata) as Record<string, unknown>,
    settings: jsonParse(r.settings) as Record<string, unknown>,
    createdBy: String(r.created_by),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    archivedAt: numNull(r.archived_at),
    deletedAt: numNull(r.deleted_at),
    version: num(r.version),
  };
}

function toMember(r: Row): Membership {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    userId: String(r.user_id),
    role: String(r.role),
    status: r.status as Membership['status'],
    invitedAt: numNull(r.invited_at),
    joinedAt: numNull(r.joined_at),
    suspendedAt: numNull(r.suspended_at),
    removedAt: numNull(r.removed_at),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    version: num(r.version),
  };
}

function toTeam(r: Row): Team {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    name: String(r.name),
    slug: String(r.slug),
    metadata: jsonParse(r.metadata) as Record<string, unknown>,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    archivedAt: numNull(r.archived_at),
    version: num(r.version),
  };
}

function toTeamMember(r: Row): TeamMembership {
  return {
    id: String(r.id),
    teamId: String(r.team_id),
    orgId: String(r.org_id),
    userId: String(r.user_id),
    role: r.role as TeamMembership['role'],
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

function toInvitation(r: Row): InvitationRecord {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    email: String(r.email),
    role: String(r.role),
    teamIds: jsonParse(r.team_ids) as string[],
    status: r.status as InvitationRecord['status'],
    invitedBy: r.invited_by === null || r.invited_by === undefined ? null : String(r.invited_by),
    tokenHash: String(r.token_hash),
    expiresAt: num(r.expires_at),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    lastSentAt: numNull(r.last_sent_at),
    sendCount: num(r.send_count),
    acceptedAt: numNull(r.accepted_at),
    revokedAt: numNull(r.revoked_at),
    version: num(r.version),
  };
}

function toTenant(r: Row): TenantRecord {
  return {
    orgId: String(r.org_id),
    strategy: r.strategy as TenantRecord['strategy'],
    handle: r.handle === null || r.handle === undefined ? null : String(r.handle),
    provisionedAt: num(r.provisioned_at),
    deprovisionedAt: numNull(r.deprovisioned_at),
    metadata: jsonParse(r.metadata) as Record<string, unknown>,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === '23505' || (typeof e.message === 'string' && /unique/i.test(e.message));
}

export function createSqlOrgsStore(
  client: SqlClient,
  options: SqlOrgsStoreOptions = {},
): OrgsStore {
  const p = resolvePrefix(options.tablePrefix);
  const t = {
    orgs: `${p}organisations`,
    members: `${p}memberships`,
    teams: `${p}teams`,
    teamMembers: `${p}team_memberships`,
    invitations: `${p}invitations`,
    tenants: `${p}tenants`,
  };

  const one = async <T>(sql: string, params: unknown[], map: (r: Row) => T): Promise<T | null> => {
    const r = await client.query<Row>(sql, params);
    const row = r.rows[0];
    return row ? map(row) : null;
  };

  return {
    async insertOrg(org) {
      try {
        await client.query(
          `INSERT INTO ${t.orgs} (id, name, slug, status, metadata, settings, created_by, created_at, updated_at, archived_at, deleted_at, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            org.id,
            org.name,
            org.slug,
            org.status,
            json(org.metadata),
            json(org.settings),
            org.createdBy,
            org.createdAt,
            org.updatedAt,
            org.archivedAt,
            org.deletedAt,
            org.version,
          ],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new OrgsError('ORGS_SLUG_TAKEN', 'Slug or id already taken', { cause: err });
        }
        throw err;
      }
      return org;
    },
    async updateOrg(org, expectedVersion) {
      const r = await client.query(
        `UPDATE ${t.orgs} SET name=$2, slug=$3, status=$4, metadata=$5, settings=$6, updated_at=$7, archived_at=$8, deleted_at=$9, version=version+1
         WHERE id=$1 AND version=$10`,
        [
          org.id,
          org.name,
          org.slug,
          org.status,
          json(org.metadata),
          json(org.settings),
          org.updatedAt,
          org.archivedAt,
          org.deletedAt,
          expectedVersion,
        ],
      );
      if (r.rowCount !== 1)
        throw new OrgsError('ORGS_VERSION_CONFLICT', 'Organisation version conflict');
      return { ...org, version: expectedVersion + 1 };
    },
    getOrg(id) {
      return one(`SELECT * FROM ${t.orgs} WHERE id = $1`, [id], toOrg);
    },
    getOrgBySlug(slug) {
      return one(`SELECT * FROM ${t.orgs} WHERE slug = $1`, [slug], toOrg);
    },
    async listOrgs(query) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status) {
        params.push(query.status);
        where.push(`status = $${params.length}`);
      }
      if (query.search) {
        params.push(`%${query.search.replace(/[%_\\]/g, '\\$&')}%`);
        where.push(
          `(LOWER(name) LIKE LOWER($${params.length}) ESCAPE '\\' OR LOWER(slug) LIKE LOWER($${params.length}) ESCAPE '\\')`,
        );
      }
      if (query.after) {
        params.push(query.after.createdAt, query.after.id);
        const a = params.length - 1;
        where.push(`(created_at > $${a} OR (created_at = $${a} AND id > $${a + 1}))`);
      }
      params.push(query.limit);
      const sql = `SELECT * FROM ${t.orgs}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC, id ASC LIMIT $${params.length}`;
      const r = await client.query<Row>(sql, params);
      return r.rows.map(toOrg);
    },

    async insertMembership(m) {
      try {
        await client.query(
          `INSERT INTO ${t.members} (id, org_id, user_id, role, status, invited_at, joined_at, suspended_at, removed_at, created_at, updated_at, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            m.id,
            m.orgId,
            m.userId,
            m.role,
            m.status,
            m.invitedAt,
            m.joinedAt,
            m.suspendedAt,
            m.removedAt,
            m.createdAt,
            m.updatedAt,
            m.version,
          ],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new OrgsError('ORGS_MEMBER_EXISTS', 'Membership already exists', { cause: err });
        }
        throw err;
      }
      return m;
    },
    async updateMembership(m, expectedVersion) {
      const r = await client.query(
        `UPDATE ${t.members} SET role=$2, status=$3, invited_at=$4, joined_at=$5, suspended_at=$6, removed_at=$7, updated_at=$8, version=version+1
         WHERE id=$1 AND version=$9`,
        [
          m.id,
          m.role,
          m.status,
          m.invitedAt,
          m.joinedAt,
          m.suspendedAt,
          m.removedAt,
          m.updatedAt,
          expectedVersion,
        ],
      );
      if (r.rowCount !== 1)
        throw new OrgsError('ORGS_VERSION_CONFLICT', 'Membership version conflict');
      return { ...m, version: expectedVersion + 1 };
    },
    getMembership(orgId, userId) {
      return one(
        `SELECT * FROM ${t.members} WHERE org_id = $1 AND user_id = $2`,
        [orgId, userId],
        toMember,
      );
    },
    getMembershipById(id) {
      return one(`SELECT * FROM ${t.members} WHERE id = $1`, [id], toMember);
    },
    async listMemberships(query) {
      const where = ['org_id = $1'];
      const params: unknown[] = [query.orgId];
      if (query.status) {
        params.push(query.status);
        where.push(`status = $${params.length}`);
      }
      if (query.after) {
        params.push(query.after.createdAt, query.after.id);
        const a = params.length - 1;
        where.push(`(created_at > $${a} OR (created_at = $${a} AND id > $${a + 1}))`);
      }
      params.push(query.limit);
      const r = await client.query<Row>(
        `SELECT * FROM ${t.members} WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
        params,
      );
      return r.rows.map(toMember);
    },
    async listMembershipsForUser(userId) {
      const r = await client.query<Row>(
        `SELECT * FROM ${t.members} WHERE user_id = $1 AND status != 'removed'`,
        [userId],
      );
      return r.rows.map(toMember);
    },
    async countOwners(orgId) {
      const r = await client.query<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM ${t.members} WHERE org_id = $1 AND role = 'owner' AND status = 'active'`,
        [orgId],
      );
      return num(r.rows[0]?.n);
    },

    async insertTeam(team) {
      try {
        await client.query(
          `INSERT INTO ${t.teams} (id, org_id, name, slug, metadata, created_at, updated_at, archived_at, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            team.id,
            team.orgId,
            team.name,
            team.slug,
            json(team.metadata),
            team.createdAt,
            team.updatedAt,
            team.archivedAt,
            team.version,
          ],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new OrgsError('ORGS_TEAM_EXISTS', 'Team already exists', { cause: err });
        }
        throw err;
      }
      return team;
    },
    async updateTeam(team, expectedVersion) {
      const r = await client.query(
        `UPDATE ${t.teams} SET name=$2, slug=$3, metadata=$4, updated_at=$5, archived_at=$6, version=version+1
         WHERE id=$1 AND version=$7`,
        [
          team.id,
          team.name,
          team.slug,
          json(team.metadata),
          team.updatedAt,
          team.archivedAt,
          expectedVersion,
        ],
      );
      if (r.rowCount !== 1) throw new OrgsError('ORGS_VERSION_CONFLICT', 'Team version conflict');
      return { ...team, version: expectedVersion + 1 };
    },
    getTeam(id) {
      return one(`SELECT * FROM ${t.teams} WHERE id = $1`, [id], toTeam);
    },
    getTeamBySlug(orgId, slug) {
      return one(`SELECT * FROM ${t.teams} WHERE org_id = $1 AND slug = $2`, [orgId, slug], toTeam);
    },
    async listTeams(orgId) {
      const r = await client.query<Row>(
        `SELECT * FROM ${t.teams} WHERE org_id = $1 AND archived_at IS NULL ORDER BY created_at ASC, id ASC`,
        [orgId],
      );
      return r.rows.map(toTeam);
    },

    async insertTeamMembership(m) {
      try {
        await client.query(
          `INSERT INTO ${t.teamMembers} (id, team_id, org_id, user_id, role, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [m.id, m.teamId, m.orgId, m.userId, m.role, m.createdAt, m.updatedAt],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new OrgsError('ORGS_MEMBER_EXISTS', 'Team membership already exists', {
            cause: err,
          });
        }
        throw err;
      }
      return m;
    },
    async deleteTeamMembership(teamId, userId) {
      const r = await client.query(
        `DELETE FROM ${t.teamMembers} WHERE team_id = $1 AND user_id = $2`,
        [teamId, userId],
      );
      return r.rowCount > 0;
    },
    getTeamMembership(teamId, userId) {
      return one(
        `SELECT * FROM ${t.teamMembers} WHERE team_id = $1 AND user_id = $2`,
        [teamId, userId],
        toTeamMember,
      );
    },
    async listTeamMemberships(teamId) {
      const r = await client.query<Row>(`SELECT * FROM ${t.teamMembers} WHERE team_id = $1`, [
        teamId,
      ]);
      return r.rows.map(toTeamMember);
    },
    async listTeamMembershipsForUser(orgId, userId) {
      const r = await client.query<Row>(
        `SELECT * FROM ${t.teamMembers} WHERE org_id = $1 AND user_id = $2`,
        [orgId, userId],
      );
      return r.rows.map(toTeamMember);
    },

    async insertInvitation(inv) {
      try {
        await client.query(
          `INSERT INTO ${t.invitations} (id, org_id, email, role, team_ids, status, invited_by, token_hash, expires_at, created_at, updated_at, last_sent_at, send_count, accepted_at, revoked_at, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            inv.id,
            inv.orgId,
            inv.email,
            inv.role,
            json(inv.teamIds),
            inv.status,
            inv.invitedBy,
            inv.tokenHash,
            inv.expiresAt,
            inv.createdAt,
            inv.updatedAt,
            inv.lastSentAt,
            inv.sendCount,
            inv.acceptedAt,
            inv.revokedAt,
            inv.version,
          ],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new OrgsError('ORGS_INVITATION_EXISTS', 'Pending invitation already exists', {
            cause: err,
          });
        }
        throw err;
      }
      return inv;
    },
    async updateInvitation(inv, expectedVersion) {
      const r = await client.query(
        `UPDATE ${t.invitations} SET role=$2, team_ids=$3, status=$4, token_hash=$5, expires_at=$6, updated_at=$7, last_sent_at=$8, send_count=$9, accepted_at=$10, revoked_at=$11, version=version+1
         WHERE id=$1 AND version=$12`,
        [
          inv.id,
          inv.role,
          json(inv.teamIds),
          inv.status,
          inv.tokenHash,
          inv.expiresAt,
          inv.updatedAt,
          inv.lastSentAt,
          inv.sendCount,
          inv.acceptedAt,
          inv.revokedAt,
          expectedVersion,
        ],
      );
      if (r.rowCount !== 1) {
        throw new OrgsError('ORGS_VERSION_CONFLICT', 'Invitation version conflict');
      }
      return { ...inv, version: expectedVersion + 1 };
    },
    getInvitation(id) {
      return one(`SELECT * FROM ${t.invitations} WHERE id = $1`, [id], toInvitation);
    },
    getPendingInvitationByEmail(orgId, email) {
      return one(
        `SELECT * FROM ${t.invitations} WHERE org_id = $1 AND email = $2 AND status = 'pending'`,
        [orgId, email],
        toInvitation,
      );
    },
    async listInvitations(query) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.orgId) {
        params.push(query.orgId);
        where.push(`org_id = $${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        where.push(`status = $${params.length}`);
      }
      if (query.after) {
        params.push(query.after.createdAt, query.after.id);
        const a = params.length - 1;
        where.push(`(created_at > $${a} OR (created_at = $${a} AND id > $${a + 1}))`);
      }
      params.push(query.limit);
      const sql = `SELECT * FROM ${t.invitations}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC, id ASC LIMIT $${params.length}`;
      const r = await client.query<Row>(sql, params);
      return r.rows.map(toInvitation);
    },

    async upsertTenant(tenant) {
      await client.query(
        `INSERT INTO ${t.tenants} (org_id, strategy, handle, provisioned_at, deprovisioned_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (org_id) DO UPDATE SET strategy=$2, handle=$3, provisioned_at=$4, deprovisioned_at=$5, metadata=$6`,
        [
          tenant.orgId,
          tenant.strategy,
          tenant.handle,
          tenant.provisionedAt,
          tenant.deprovisionedAt,
          json(tenant.metadata),
        ],
      );
      return tenant;
    },
    getTenant(orgId) {
      return one(`SELECT * FROM ${t.tenants} WHERE org_id = $1`, [orgId], toTenant);
    },
    async deleteTenant(orgId) {
      const r = await client.query(`DELETE FROM ${t.tenants} WHERE org_id = $1`, [orgId]);
      return r.rowCount > 0;
    },
  };
}
