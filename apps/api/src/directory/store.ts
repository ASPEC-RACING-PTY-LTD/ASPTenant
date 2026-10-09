import { randomUUID } from 'node:crypto';
import type { SqlClient } from '@aspec/db';
import type {
  DirectoryApplication,
  DirectoryCounts,
  DirectoryDomain,
  DirectoryGroup,
  DirectoryGroupMember,
  DirectoryMailbox,
  DomainStatus,
  GroupKind,
  MailboxKind,
} from './types.js';

type Row = Record<string, unknown>;

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value));
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : num(value);
const strOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function toGroup(row: Row, memberCount: number): DirectoryGroup {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    slug: String(row.slug),
    kind: String(row.kind) as GroupKind,
    email: strOrNull(row.email),
    description: strOrNull(row.description),
    memberCount,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function toDomain(row: Row): DirectoryDomain {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    hostname: String(row.hostname),
    status: String(row.status) as DomainStatus,
    primary: num(row.is_primary) === 1,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    verifiedAt: numOrNull(row.verified_at),
  };
}

function toMailbox(row: Row, aliases: string[]): DirectoryMailbox {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: strOrNull(row.user_id),
    primaryAddress: String(row.primary_address),
    kind: String(row.kind) as MailboxKind,
    displayName: strOrNull(row.display_name),
    quotaBytes: numOrNull(row.quota_bytes),
    aliases,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function toApplication(row: Row): DirectoryApplication {
  const raw = row.redirect_uris;
  const redirectUris = typeof raw === 'string' ? (JSON.parse(raw) as string[]) : (raw as string[]);
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    clientId: String(row.client_id),
    redirectUris,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

export class DirectoryStore {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async listGroups(tenantId: string): Promise<DirectoryGroup[]> {
    const groups = await this.db.query(
      `SELECT * FROM aspectenant_groups WHERE tenant_id = $1 ORDER BY name ASC`,
      [tenantId],
    );
    const counts = await this.db.query<{ group_id: string; n: unknown }>(
      `SELECT group_id, COUNT(*) AS n FROM aspectenant_group_members
       WHERE tenant_id = $1 GROUP BY group_id`,
      [tenantId],
    );
    const countById = new Map(counts.rows.map((row) => [String(row.group_id), num(row.n)]));
    return groups.rows.map((row) => toGroup(row, countById.get(String(row.id)) ?? 0));
  }

  async getGroup(tenantId: string, id: string): Promise<DirectoryGroup | null> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_groups WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const count = await this.db.query<{ n: unknown }>(
      `SELECT COUNT(*) AS n FROM aspectenant_group_members WHERE group_id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return toGroup(row, num(count.rows[0]?.n ?? 0));
  }

  async findGroupBySlug(tenantId: string, slug: string): Promise<DirectoryGroup | null> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_groups WHERE tenant_id = $1 AND slug = $2`,
      [tenantId, slug],
    );
    const row = result.rows[0];
    return row ? toGroup(row, 0) : null;
  }

  async findGroupByEmail(tenantId: string, email: string): Promise<DirectoryGroup | null> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_groups WHERE tenant_id = $1 AND email = $2`,
      [tenantId, email],
    );
    const row = result.rows[0];
    return row ? toGroup(row, 0) : null;
  }

  async insertGroup(input: {
    tenantId: string;
    name: string;
    slug: string;
    kind: GroupKind;
    email: string | null;
    description: string | null;
  }): Promise<DirectoryGroup> {
    const now = Date.now();
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO aspectenant_groups (id, tenant_id, name, slug, kind, email, description, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        input.tenantId,
        input.name,
        input.slug,
        input.kind,
        input.email,
        input.description,
        now,
        now,
      ],
    );
    return {
      id,
      tenantId: input.tenantId,
      name: input.name,
      slug: input.slug,
      kind: input.kind,
      email: input.email,
      description: input.description,
      memberCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  async updateGroup(
    tenantId: string,
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      kind?: GroupKind;
      email?: string | null;
    },
  ): Promise<DirectoryGroup | null> {
    const current = await this.getGroup(tenantId, id);
    if (!current) return null;
    const now = Date.now();
    const name = patch.name ?? current.name;
    const description = patch.description === undefined ? current.description : patch.description;
    const kind = patch.kind ?? current.kind;
    const email = patch.email === undefined ? current.email : patch.email;
    await this.db.query(
      `UPDATE aspectenant_groups SET name = $1, description = $2, kind = $3, email = $4, updated_at = $5
       WHERE id = $6 AND tenant_id = $7`,
      [name, description, kind, email, now, id, tenantId],
    );
    return { ...current, name, description, kind, email, updatedAt: now };
  }

  async listMailboxMembers(
    tenantId: string,
    mailboxId: string,
  ): Promise<{ userId: string; addedAt: number }[]> {
    const result = await this.db.query(
      `SELECT user_id, added_at FROM aspectenant_mailbox_members
       WHERE tenant_id = $1 AND mailbox_id = $2 ORDER BY added_at`,
      [tenantId, mailboxId],
    );
    return result.rows.map((row) => ({ userId: String(row.user_id), addedAt: num(row.added_at) }));
  }

  async addMailboxMember(tenantId: string, mailboxId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO aspectenant_mailbox_members (tenant_id, mailbox_id, user_id, added_at)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, mailboxId, userId, Date.now()],
    );
  }

  async removeMailboxMember(tenantId: string, mailboxId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM aspectenant_mailbox_members
       WHERE tenant_id = $1 AND mailbox_id = $2 AND user_id = $3`,
      [tenantId, mailboxId, userId],
    );
    return result.rowCount > 0;
  }

  /** Mailboxes a user may open: their own user mailbox plus delegated ones. */
  async listAccessibleMailboxes(tenantId: string, userId: string): Promise<DirectoryMailbox[]> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_mailboxes WHERE tenant_id = $1 AND (user_id = $2 OR id IN
         (SELECT mailbox_id FROM aspectenant_mailbox_members WHERE tenant_id = $1 AND user_id = $2))
       ORDER BY kind DESC, primary_address ASC`,
      [tenantId, userId],
    );
    return Promise.all(result.rows.map((row) => this.hydrateMailbox(row)));
  }

  async deleteGroup(tenantId: string, id: string): Promise<boolean> {
    await this.db.query(
      `DELETE FROM aspectenant_group_members WHERE group_id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    const result = await this.db.query(
      `DELETE FROM aspectenant_groups WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return result.rowCount > 0;
  }

  async listGroupMembers(tenantId: string, groupId: string): Promise<DirectoryGroupMember[]> {
    const result = await this.db.query(
      `SELECT group_id, user_id, added_at FROM aspectenant_group_members
       WHERE tenant_id = $1 AND group_id = $2 ORDER BY added_at ASC`,
      [tenantId, groupId],
    );
    return result.rows.map((row) => ({
      groupId: String(row.group_id),
      userId: String(row.user_id),
      addedAt: num(row.added_at),
    }));
  }

  async addGroupMember(
    tenantId: string,
    groupId: string,
    userId: string,
  ): Promise<DirectoryGroupMember> {
    const addedAt = Date.now();
    await this.db.query(
      `INSERT INTO aspectenant_group_members (tenant_id, group_id, user_id, added_at)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, groupId, userId, addedAt],
    );
    return { groupId, userId, addedAt };
  }

  async hasGroupMember(tenantId: string, groupId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM aspectenant_group_members
       WHERE tenant_id = $1 AND group_id = $2 AND user_id = $3`,
      [tenantId, groupId, userId],
    );
    return result.rows.length > 0;
  }

  async removeGroupMember(tenantId: string, groupId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM aspectenant_group_members
       WHERE tenant_id = $1 AND group_id = $2 AND user_id = $3`,
      [tenantId, groupId, userId],
    );
    return result.rowCount > 0;
  }

  /** Removes a user from every group and delegated mailbox in one tenant (membership ended). */
  async detachUser(tenantId: string, userId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM aspectenant_group_members WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    await this.db.query(
      `DELETE FROM aspectenant_mailbox_members WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
  }

  async listDomains(tenantId: string): Promise<DirectoryDomain[]> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_domains WHERE tenant_id = $1 ORDER BY is_primary DESC, hostname ASC`,
      [tenantId],
    );
    return result.rows.map(toDomain);
  }

  async getDomain(tenantId: string, id: string): Promise<DirectoryDomain | null> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_domains WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  }

  async findDomainByHostname(tenantId: string, hostname: string): Promise<DirectoryDomain | null> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_domains WHERE tenant_id = $1 AND hostname = $2`,
      [tenantId, hostname],
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  }

  /**
   * Verified owner of a hostname in any tenant. Under row-level security only the caller's own
   * rows are visible; the partial unique index still refuses a second verified owner.
   */
  async findVerifiedDomain(hostname: string): Promise<DirectoryDomain | null> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_domains WHERE hostname = $1 AND status = 'verified'`,
      [hostname],
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  }

  async insertDomain(input: {
    tenantId: string;
    hostname: string;
    primary: boolean;
  }): Promise<DirectoryDomain> {
    const now = Date.now();
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO aspectenant_domains
        (id, tenant_id, hostname, status, is_primary, created_at, updated_at, verified_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, NULL)`,
      [id, input.tenantId, input.hostname, input.primary ? 1 : 0, now, now],
    );
    return {
      id,
      tenantId: input.tenantId,
      hostname: input.hostname,
      status: 'pending',
      primary: input.primary,
      createdAt: now,
      updatedAt: now,
      verifiedAt: null,
    };
  }

  async updateDomain(
    tenantId: string,
    id: string,
    patch: { status?: DomainStatus; primary?: boolean; verifiedAt?: number | null },
  ): Promise<DirectoryDomain | null> {
    const current = await this.getDomain(tenantId, id);
    if (!current) return null;
    const now = Date.now();
    const status = patch.status ?? current.status;
    const primary = patch.primary ?? current.primary;
    const verifiedAt = patch.verifiedAt === undefined ? current.verifiedAt : patch.verifiedAt;
    await this.db.query(
      `UPDATE aspectenant_domains
       SET status = $1, is_primary = $2, verified_at = $3, updated_at = $4
       WHERE id = $5 AND tenant_id = $6`,
      [status, primary ? 1 : 0, verifiedAt, now, id, tenantId],
    );
    return { ...current, status, primary, verifiedAt, updatedAt: now };
  }

  async clearPrimaryDomain(tenantId: string): Promise<void> {
    await this.db.query(
      `UPDATE aspectenant_domains SET is_primary = 0, updated_at = $1 WHERE tenant_id = $2 AND is_primary = 1`,
      [Date.now(), tenantId],
    );
  }

  /** Mailbox addresses, aliases and group addresses in one tenant that use a hostname. */
  async countAddressesOnDomain(tenantId: string, hostname: string): Promise<number> {
    const suffix = `%@${hostname}`;
    let total = 0;
    for (const sql of [
      `SELECT COUNT(*) AS n FROM aspectenant_mailboxes WHERE tenant_id = $1 AND primary_address LIKE $2`,
      `SELECT COUNT(*) AS n FROM aspectenant_mailbox_aliases WHERE tenant_id = $1 AND alias LIKE $2`,
      `SELECT COUNT(*) AS n FROM aspectenant_groups WHERE tenant_id = $1 AND email LIKE $2`,
    ]) {
      const result = await this.db.query<{ n: unknown }>(sql, [tenantId, suffix]);
      total += num(result.rows[0]?.n ?? 0);
    }
    return total;
  }

  async deleteDomain(tenantId: string, id: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM aspectenant_domains WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return result.rowCount > 0;
  }

  async listMailboxes(tenantId: string): Promise<DirectoryMailbox[]> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_mailboxes WHERE tenant_id = $1 ORDER BY primary_address ASC`,
      [tenantId],
    );
    return Promise.all(result.rows.map((row) => this.hydrateMailbox(row)));
  }

  async getMailbox(tenantId: string, id: string): Promise<DirectoryMailbox | null> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_mailboxes WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    const row = result.rows[0];
    return row ? this.hydrateMailbox(row) : null;
  }

  async findMailboxByAddress(tenantId: string, address: string): Promise<DirectoryMailbox | null> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_mailboxes WHERE tenant_id = $1 AND primary_address = $2`,
      [tenantId, address],
    );
    const row = result.rows[0];
    if (row) return this.hydrateMailbox(row);
    const alias = await this.db.query(
      `SELECT m.* FROM aspectenant_mailboxes m
       INNER JOIN aspectenant_mailbox_aliases a ON a.mailbox_id = m.id
       WHERE m.tenant_id = $1 AND a.tenant_id = $1 AND a.alias = $2`,
      [tenantId, address],
    );
    const aliasRow = alias.rows[0];
    return aliasRow ? this.hydrateMailbox(aliasRow) : null;
  }

  async findMailboxByUser(tenantId: string, userId: string): Promise<DirectoryMailbox | null> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_mailboxes WHERE tenant_id = $1 AND user_id = $2 AND kind = 'user'`,
      [tenantId, userId],
    );
    const row = result.rows[0];
    return row ? this.hydrateMailbox(row) : null;
  }

  async insertMailbox(input: {
    tenantId: string;
    userId: string | null;
    primaryAddress: string;
    kind: MailboxKind;
    displayName: string | null;
    quotaBytes: number | null;
  }): Promise<DirectoryMailbox> {
    const now = Date.now();
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO aspectenant_mailboxes
        (id, tenant_id, user_id, primary_address, kind, display_name, quota_bytes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        input.tenantId,
        input.userId,
        input.primaryAddress,
        input.kind,
        input.displayName,
        input.quotaBytes,
        now,
        now,
      ],
    );
    return {
      id,
      tenantId: input.tenantId,
      userId: input.userId,
      primaryAddress: input.primaryAddress,
      kind: input.kind,
      displayName: input.displayName,
      quotaBytes: input.quotaBytes,
      aliases: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async updateMailbox(
    tenantId: string,
    id: string,
    patch: { displayName?: string | null; quotaBytes?: number | null },
  ): Promise<DirectoryMailbox | null> {
    const current = await this.getMailbox(tenantId, id);
    if (!current) return null;
    const now = Date.now();
    const displayName = patch.displayName === undefined ? current.displayName : patch.displayName;
    const quotaBytes = patch.quotaBytes === undefined ? current.quotaBytes : patch.quotaBytes;
    await this.db.query(
      `UPDATE aspectenant_mailboxes SET display_name = $1, quota_bytes = $2, updated_at = $3
       WHERE id = $4 AND tenant_id = $5`,
      [displayName, quotaBytes, now, id, tenantId],
    );
    return { ...current, displayName, quotaBytes, updatedAt: now };
  }

  async deleteMailbox(tenantId: string, id: string): Promise<boolean> {
    await this.db.query(
      `DELETE FROM aspectenant_mailbox_aliases WHERE mailbox_id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await this.db.query(
      `DELETE FROM aspectenant_mailbox_members WHERE mailbox_id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await this.db.query(
      `DELETE FROM aspectenant_messages WHERE mailbox_id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    const result = await this.db.query(
      `DELETE FROM aspectenant_mailboxes WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return result.rowCount > 0;
  }

  async addAlias(tenantId: string, mailboxId: string, alias: string): Promise<void> {
    await this.db.query(
      `INSERT INTO aspectenant_mailbox_aliases (tenant_id, mailbox_id, alias, created_at)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, mailboxId, alias, Date.now()],
    );
  }

  async removeAlias(tenantId: string, mailboxId: string, alias: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM aspectenant_mailbox_aliases
       WHERE tenant_id = $1 AND mailbox_id = $2 AND alias = $3`,
      [tenantId, mailboxId, alias],
    );
    return result.rowCount > 0;
  }

  async listApplications(tenantId: string): Promise<DirectoryApplication[]> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_applications WHERE tenant_id = $1 ORDER BY name ASC`,
      [tenantId],
    );
    return result.rows.map(toApplication);
  }

  async getApplication(tenantId: string, id: string): Promise<DirectoryApplication | null> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_applications WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    const row = result.rows[0];
    return row ? toApplication(row) : null;
  }

  async insertApplication(input: {
    tenantId: string;
    name: string;
    clientId: string;
    redirectUris: string[];
  }): Promise<DirectoryApplication> {
    const now = Date.now();
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO aspectenant_applications
        (id, tenant_id, name, client_id, redirect_uris, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.tenantId,
        input.name,
        input.clientId,
        JSON.stringify(input.redirectUris),
        now,
        now,
      ],
    );
    return {
      id,
      tenantId: input.tenantId,
      name: input.name,
      clientId: input.clientId,
      redirectUris: input.redirectUris,
      createdAt: now,
      updatedAt: now,
    };
  }

  async updateApplication(
    tenantId: string,
    id: string,
    patch: { name?: string; redirectUris?: string[] },
  ): Promise<DirectoryApplication | null> {
    const current = await this.getApplication(tenantId, id);
    if (!current) return null;
    const now = Date.now();
    const name = patch.name ?? current.name;
    const redirectUris = patch.redirectUris ?? current.redirectUris;
    await this.db.query(
      `UPDATE aspectenant_applications SET name = $1, redirect_uris = $2, updated_at = $3
       WHERE id = $4 AND tenant_id = $5`,
      [name, JSON.stringify(redirectUris), now, id, tenantId],
    );
    return { ...current, name, redirectUris, updatedAt: now };
  }

  async deleteApplication(tenantId: string, id: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM aspectenant_applications WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return result.rowCount > 0;
  }

  async counts(tenantId: string): Promise<DirectoryCounts> {
    const [groups, domains, mailboxes, applications] = await Promise.all([
      this.db.query<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM aspectenant_groups WHERE tenant_id = $1`,
        [tenantId],
      ),
      this.db.query<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM aspectenant_domains WHERE tenant_id = $1`,
        [tenantId],
      ),
      this.db.query<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM aspectenant_mailboxes WHERE tenant_id = $1`,
        [tenantId],
      ),
      this.db.query<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM aspectenant_applications WHERE tenant_id = $1`,
        [tenantId],
      ),
    ]);
    return {
      groups: num(groups.rows[0]?.n ?? 0),
      domains: num(domains.rows[0]?.n ?? 0),
      mailboxes: num(mailboxes.rows[0]?.n ?? 0),
      applications: num(applications.rows[0]?.n ?? 0),
    };
  }

  private async hydrateMailbox(row: Row): Promise<DirectoryMailbox> {
    const aliases = await this.db.query<{ alias: string }>(
      `SELECT alias FROM aspectenant_mailbox_aliases
       WHERE mailbox_id = $1 AND tenant_id = $2 ORDER BY alias ASC`,
      [String(row.id), String(row.tenant_id)],
    );
    return toMailbox(
      row,
      aliases.rows.map((item) => String(item.alias)),
    );
  }
}
