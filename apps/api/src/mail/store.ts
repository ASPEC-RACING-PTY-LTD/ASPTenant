import { randomUUID } from 'node:crypto';
import type { SqlClient } from '@aspec/db';

/** System folders every mailbox has. Names are IMAP names. */
export const SYSTEM_FOLDERS = [
  { name: 'INBOX', specialUse: null },
  { name: 'Drafts', specialUse: '\\Drafts' },
  { name: 'Sent', specialUse: '\\Sent' },
  { name: 'Archive', specialUse: '\\Archive' },
  { name: 'Junk', specialUse: '\\Junk' },
  { name: 'Trash', specialUse: '\\Trash' },
] as const;

export type MailFolder = string;

export interface MailAddress {
  address: string;
  name: string | null;
}

export interface MessageFlags {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  deleted: boolean;
}

export interface StoredMessage extends MessageFlags {
  id: string;
  tenantId: string;
  mailboxId: string;
  folder: string;
  uid: number;
  messageId: string | null;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  sentAt: number | null;
  receivedAt: number;
  sizeBytes: number;
  hasAttachments: boolean;
  snippet: string;
}

export interface NewMessage {
  tenantId: string;
  mailboxId: string;
  folder: string;
  messageId: string | null;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  sentAt: number | null;
  receivedAt?: number;
  seen: boolean;
  flagged: boolean;
  answered?: boolean;
  draft?: boolean;
  hasAttachments: boolean;
  snippet: string;
  importKey?: string | null;
  raw: Uint8Array;
}

export interface MailFolderRecord {
  id: string;
  mailboxId: string;
  name: string;
  specialUse: string | null;
  uidValidity: number;
  uidNext: number;
  subscribed: boolean;
}

/** Light row for IMAP sequence maps. */
export interface UidRow extends MessageFlags {
  id: string;
  uid: number;
  sizeBytes: number;
  receivedAt: number;
}

type Row = Record<string, unknown>;
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value));
const bool = (value: unknown): boolean => value === true || num(value) === 1;

const LIST_COLUMNS = `id, tenant_id, mailbox_id, folder, uid, message_id, subject, from_address, from_name,
  to_json, cc_json, sent_at, received_at, size_bytes, seen, flagged, answered, draft, deleted,
  has_attachments, snippet`;

function toMessage(row: Row): StoredMessage {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    mailboxId: String(row.mailbox_id),
    folder: String(row.folder),
    uid: num(row.uid ?? 0),
    messageId:
      row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
    subject: String(row.subject),
    from: {
      address: String(row.from_address),
      name: row.from_name === null || row.from_name === undefined ? null : String(row.from_name),
    },
    to: JSON.parse(String(row.to_json)) as MailAddress[],
    cc: JSON.parse(String(row.cc_json)) as MailAddress[],
    sentAt: row.sent_at === null || row.sent_at === undefined ? null : num(row.sent_at),
    receivedAt: num(row.received_at),
    sizeBytes: num(row.size_bytes),
    seen: bool(row.seen),
    flagged: bool(row.flagged),
    answered: bool(row.answered),
    draft: bool(row.draft),
    deleted: bool(row.deleted),
    hasAttachments: bool(row.has_attachments),
    snippet: String(row.snippet),
  };
}

function toFolder(row: Row): MailFolderRecord {
  return {
    id: String(row.id),
    mailboxId: String(row.mailbox_id),
    name: String(row.name),
    specialUse: row.special_use ? String(row.special_use) : null,
    uidValidity: num(row.uid_validity),
    uidNext: num(row.uid_next),
    subscribed: bool(row.subscribed),
  };
}

/** Case-insensitive INBOX, everything else as given. */
export function normaliseFolderName(name: string): string {
  const trimmed = name.trim().replace(/^\/+|\/+$/g, '');
  return trimmed.toUpperCase() === 'INBOX' ? 'INBOX' : trimmed;
}

export class MessageStore {
  private readonly db: SqlClient;
  private readonly ensured = new Set<string>();

  constructor(db: SqlClient) {
    this.db = db;
  }

  async ensureFolders(tenantId: string, mailboxId: string): Promise<void> {
    if (this.ensured.has(mailboxId)) return;
    const existing = await this.listFolders(mailboxId);
    for (const folder of SYSTEM_FOLDERS) {
      if (!existing.some((item) => item.name === folder.name)) {
        await this.insertFolder(tenantId, mailboxId, folder.name, folder.specialUse);
      }
    }
    // Backfill UIDs for messages stored before IMAP existed.
    const missing = await this.db.query(
      `SELECT id, folder FROM aspectenant_messages WHERE mailbox_id = $1 AND uid IS NULL ORDER BY received_at`,
      [mailboxId],
    );
    for (const row of missing.rows) {
      const folder = String(row.folder);
      if (!(await this.getFolder(mailboxId, folder))) {
        await this.insertFolder(tenantId, mailboxId, folder, null);
      }
      const uid = await this.allocUid(mailboxId, folder);
      await this.db.query(`UPDATE aspectenant_messages SET uid = $1 WHERE id = $2`, [uid, row.id]);
    }
    this.ensured.add(mailboxId);
  }

  private async insertFolder(
    tenantId: string,
    mailboxId: string,
    name: string,
    specialUse: string | null,
  ): Promise<MailFolderRecord> {
    const id = randomUUID();
    const uidValidity = Math.floor(Date.now() / 1000);
    await this.db.query(
      `INSERT INTO aspectenant_mail_folders
        (id, tenant_id, mailbox_id, name, special_use, uid_validity, uid_next, subscribed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1, $7)`,
      [id, tenantId, mailboxId, name, specialUse, uidValidity, Date.now()],
    );
    return { id, mailboxId, name, specialUse, uidValidity, uidNext: 1, subscribed: true };
  }

  async listFolders(mailboxId: string): Promise<MailFolderRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_mail_folders WHERE mailbox_id = $1 ORDER BY name`,
      [mailboxId],
    );
    const order = SYSTEM_FOLDERS.map((item) => item.name as string);
    return result.rows.map(toFolder).sort((a, b) => {
      const ia = order.indexOf(a.name);
      const ib = order.indexOf(b.name);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.name.localeCompare(b.name);
    });
  }

  async getFolder(mailboxId: string, name: string): Promise<MailFolderRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_mail_folders WHERE mailbox_id = $1 AND name = $2`,
      [mailboxId, normaliseFolderName(name)],
    );
    const row = result.rows[0];
    return row ? toFolder(row) : null;
  }

  async createFolder(tenantId: string, mailboxId: string, name: string): Promise<MailFolderRecord> {
    const clean = normaliseFolderName(name);
    const existing = await this.getFolder(mailboxId, clean);
    if (existing) return existing;
    // Create missing parents so hierarchy listings stay consistent.
    const parts = clean.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join('/');
      if (!(await this.getFolder(mailboxId, parent))) {
        await this.insertFolder(tenantId, mailboxId, parent, null);
      }
    }
    return this.insertFolder(tenantId, mailboxId, clean, null);
  }

  async renameFolder(mailboxId: string, from: string, to: string): Promise<void> {
    const source = normaliseFolderName(from);
    const target = normaliseFolderName(to);
    const folders = await this.listFolders(mailboxId);
    for (const folder of folders) {
      if (folder.name === source || folder.name.startsWith(`${source}/`)) {
        const renamed = target + folder.name.slice(source.length);
        await this.db.query(`UPDATE aspectenant_mail_folders SET name = $1 WHERE id = $2`, [
          renamed,
          folder.id,
        ]);
        await this.db.query(
          `UPDATE aspectenant_messages SET folder = $1 WHERE mailbox_id = $2 AND folder = $3`,
          [renamed, mailboxId, folder.name],
        );
      }
    }
  }

  async deleteFolder(mailboxId: string, name: string): Promise<void> {
    const clean = normaliseFolderName(name);
    await this.db.query(`DELETE FROM aspectenant_messages WHERE mailbox_id = $1 AND folder = $2`, [
      mailboxId,
      clean,
    ]);
    await this.db.query(
      `DELETE FROM aspectenant_mail_folders WHERE mailbox_id = $1 AND name = $2`,
      [mailboxId, clean],
    );
  }

  async setSubscribed(mailboxId: string, name: string, subscribed: boolean): Promise<void> {
    await this.db.query(
      `UPDATE aspectenant_mail_folders SET subscribed = $1 WHERE mailbox_id = $2 AND name = $3`,
      [subscribed ? 1 : 0, mailboxId, normaliseFolderName(name)],
    );
  }

  /** Reserves the next UID in a folder. The row update serialises concurrent writers. */
  private async allocUid(mailboxId: string, folder: string): Promise<number> {
    return this.db.transaction(async () => {
      const updated = await this.db.query(
        `UPDATE aspectenant_mail_folders SET uid_next = uid_next + 1 WHERE mailbox_id = $1 AND name = $2`,
        [mailboxId, folder],
      );
      if (updated.rowCount === 0) throw new Error(`Folder ${folder} does not exist`);
      const result = await this.db.query(
        `SELECT uid_next FROM aspectenant_mail_folders WHERE mailbox_id = $1 AND name = $2`,
        [mailboxId, folder],
      );
      return num(result.rows[0]?.uid_next) - 1;
    });
  }

  async insert(input: NewMessage): Promise<StoredMessage> {
    await this.ensureFolders(input.tenantId, input.mailboxId);
    if (!(await this.getFolder(input.mailboxId, input.folder))) {
      await this.createFolder(input.tenantId, input.mailboxId, input.folder);
    }
    const folder = normaliseFolderName(input.folder);
    const id = randomUUID();
    const receivedAt = input.receivedAt ?? Date.now();
    const uid = await this.allocUid(input.mailboxId, folder);
    await this.db.query(
      `INSERT INTO aspectenant_messages (id, tenant_id, mailbox_id, folder, uid, message_id, subject,
        from_address, from_name, to_json, cc_json, sent_at, received_at, size_bytes, seen, flagged,
        answered, draft, deleted, has_attachments, snippet, import_key, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 0,
        $19, $20, $21, $22)`,
      [
        id,
        input.tenantId,
        input.mailboxId,
        folder,
        uid,
        input.messageId,
        input.subject,
        input.from.address,
        input.from.name,
        JSON.stringify(input.to),
        JSON.stringify(input.cc),
        input.sentAt,
        receivedAt,
        input.raw.byteLength,
        input.seen ? 1 : 0,
        input.flagged ? 1 : 0,
        input.answered ? 1 : 0,
        input.draft ? 1 : 0,
        input.hasAttachments ? 1 : 0,
        input.snippet,
        input.importKey ?? null,
        Buffer.from(input.raw),
      ],
    );
    return {
      id,
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      folder,
      uid,
      messageId: input.messageId,
      subject: input.subject,
      from: input.from,
      to: input.to,
      cc: input.cc,
      sentAt: input.sentAt,
      receivedAt,
      sizeBytes: input.raw.byteLength,
      seen: input.seen,
      flagged: input.flagged,
      answered: input.answered ?? false,
      draft: input.draft ?? false,
      deleted: false,
      hasAttachments: input.hasAttachments,
      snippet: input.snippet,
    };
  }

  async exists(mailboxId: string, messageId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM aspectenant_messages WHERE mailbox_id = $1 AND message_id = $2 AND folder = 'INBOX' LIMIT 1`,
      [mailboxId, messageId],
    );
    return result.rows.length > 0;
  }

  async hasImportKey(mailboxId: string, key: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM aspectenant_messages WHERE mailbox_id = $1 AND import_key = $2 LIMIT 1`,
      [mailboxId, key],
    );
    return result.rows.length > 0;
  }

  async list(
    mailboxId: string,
    folder: string,
    options: { limit: number; before?: number; search?: string },
  ): Promise<StoredMessage[]> {
    const params: unknown[] = [mailboxId, normaliseFolderName(folder)];
    let where = 'mailbox_id = $1 AND folder = $2';
    if (options.before !== undefined) {
      params.push(options.before);
      where += ` AND received_at < $${params.length}`;
    }
    if (options.search) {
      params.push(`%${options.search.toLowerCase()}%`);
      const n = params.length;
      where += ` AND (LOWER(subject) LIKE $${n} OR LOWER(from_address) LIKE $${n} OR LOWER(snippet) LIKE $${n})`;
    }
    params.push(options.limit);
    const result = await this.db.query(
      `SELECT ${LIST_COLUMNS} FROM aspectenant_messages WHERE ${where}
       ORDER BY received_at DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(toMessage);
  }

  async folderCounts(
    mailboxId: string,
  ): Promise<Record<string, { total: number; unread: number }>> {
    const result = await this.db.query(
      `SELECT folder, COUNT(*) AS total, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unread
       FROM aspectenant_messages WHERE mailbox_id = $1 GROUP BY folder`,
      [mailboxId],
    );
    const out: Record<string, { total: number; unread: number }> = {};
    for (const row of result.rows) {
      out[String(row.folder)] = { total: num(row.total), unread: num(row.unread ?? 0) };
    }
    return out;
  }

  /** UID-ordered flag rows for one folder (IMAP sequence map). */
  async uidRows(mailboxId: string, folder: string): Promise<UidRow[]> {
    const result = await this.db.query(
      `SELECT id, uid, seen, flagged, answered, draft, deleted, size_bytes, received_at
       FROM aspectenant_messages WHERE mailbox_id = $1 AND folder = $2 ORDER BY uid`,
      [mailboxId, normaliseFolderName(folder)],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      uid: num(row.uid),
      seen: bool(row.seen),
      flagged: bool(row.flagged),
      answered: bool(row.answered),
      draft: bool(row.draft),
      deleted: bool(row.deleted),
      sizeBytes: num(row.size_bytes),
      receivedAt: num(row.received_at),
    }));
  }

  async get(id: string): Promise<StoredMessage | null> {
    const result = await this.db.query(
      `SELECT ${LIST_COLUMNS} FROM aspectenant_messages WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toMessage(row) : null;
  }

  async raw(id: string): Promise<Buffer | null> {
    const result = await this.db.query(`SELECT raw FROM aspectenant_messages WHERE id = $1`, [id]);
    const value = result.rows[0]?.raw;
    if (value === undefined || value === null) return null;
    return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
  }

  async setFlags(id: string, patch: Partial<MessageFlags>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of ['seen', 'flagged', 'answered', 'draft', 'deleted'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(value ? 1 : 0);
      sets.push(`${key} = $${params.length}`);
    }
    if (sets.length === 0) return;
    params.push(id);
    await this.db.query(
      `UPDATE aspectenant_messages SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
  }

  /** Moves a message and gives it a new UID in the target folder. */
  async move(id: string, folder: string): Promise<number> {
    const message = await this.get(id);
    if (!message) throw new Error('Message not found');
    const target = normaliseFolderName(folder);
    if (!(await this.getFolder(message.mailboxId, target))) {
      await this.createFolder(message.tenantId, message.mailboxId, target);
    }
    const uid = await this.allocUid(message.mailboxId, target);
    await this.db.query(
      `UPDATE aspectenant_messages SET folder = $1, uid = $2, deleted = 0 WHERE id = $3`,
      [target, uid, id],
    );
    return uid;
  }

  async copy(id: string, folder: string): Promise<number> {
    const message = await this.get(id);
    const raw = await this.raw(id);
    if (!message || !raw) throw new Error('Message not found');
    const copied = await this.insert({
      tenantId: message.tenantId,
      mailboxId: message.mailboxId,
      folder,
      messageId: message.messageId,
      subject: message.subject,
      from: message.from,
      to: message.to,
      cc: message.cc,
      sentAt: message.sentAt,
      receivedAt: message.receivedAt,
      seen: message.seen,
      flagged: message.flagged,
      answered: message.answered,
      draft: message.draft,
      hasAttachments: message.hasAttachments,
      snippet: message.snippet,
      raw,
    });
    return copied.uid;
  }

  /** Removes \\Deleted messages from a folder (optionally only some UIDs). Returns removed UIDs. */
  async expunge(mailboxId: string, folder: string, uids?: number[]): Promise<number[]> {
    const rows = (await this.uidRows(mailboxId, folder)).filter(
      (row) => row.deleted && (!uids || uids.includes(row.uid)),
    );
    for (const row of rows) await this.delete(row.id);
    return rows.map((row) => row.uid);
  }

  async delete(id: string): Promise<void> {
    await this.db.query(`DELETE FROM aspectenant_messages WHERE id = $1`, [id]);
  }

  async emptyFolder(mailboxId: string, folder: string): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM aspectenant_messages WHERE mailbox_id = $1 AND folder = $2`,
      [mailboxId, normaliseFolderName(folder)],
    );
    return result.rowCount;
  }

  async count(): Promise<number> {
    const result = await this.db.query(`SELECT COUNT(*) AS n FROM aspectenant_messages`);
    return num(result.rows[0]?.n ?? 0);
  }
}

export class SettingsStore {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async get<T>(tenantId: string, key: string): Promise<T | null> {
    const result = await this.db.query(
      `SELECT value FROM aspectenant_settings WHERE tenant_id = $1 AND key = $2`,
      [tenantId, key],
    );
    const value = result.rows[0]?.value;
    return value === undefined ? null : (JSON.parse(String(value)) as T);
  }

  async set(tenantId: string, key: string, value: unknown): Promise<void> {
    const now = Date.now();
    const json = JSON.stringify(value);
    const updated = await this.db.query(
      `UPDATE aspectenant_settings SET value = $1, updated_at = $2 WHERE tenant_id = $3 AND key = $4`,
      [json, now, tenantId, key],
    );
    if (updated.rowCount === 0) {
      await this.db.query(
        `INSERT INTO aspectenant_settings (tenant_id, key, value, updated_at) VALUES ($1, $2, $3, $4)`,
        [tenantId, key, json, now],
      );
    }
  }
}
