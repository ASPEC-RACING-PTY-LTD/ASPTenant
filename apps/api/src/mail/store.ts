import { randomUUID } from 'node:crypto';
import type { SqlClient } from '@aspec/db';

export const MAIL_FOLDERS = ['inbox', 'sent', 'archive', 'junk', 'trash'] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

export interface MailAddress {
  address: string;
  name: string | null;
}

export interface StoredMessage {
  id: string;
  tenantId: string;
  mailboxId: string;
  folder: MailFolder;
  messageId: string | null;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  sentAt: number | null;
  receivedAt: number;
  sizeBytes: number;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  snippet: string;
}

export type NewMessage = Omit<StoredMessage, 'id' | 'receivedAt' | 'sizeBytes'> & {
  raw: Uint8Array;
};

type Row = Record<string, unknown>;
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value));

const LIST_COLUMNS = `id, tenant_id, mailbox_id, folder, message_id, subject, from_address, from_name,
  to_json, cc_json, sent_at, received_at, size_bytes, seen, flagged, has_attachments, snippet`;

function toMessage(row: Row): StoredMessage {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    mailboxId: String(row.mailbox_id),
    folder: String(row.folder) as MailFolder,
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
    seen: num(row.seen) === 1 || row.seen === true,
    flagged: num(row.flagged) === 1 || row.flagged === true,
    hasAttachments: num(row.has_attachments) === 1 || row.has_attachments === true,
    snippet: String(row.snippet),
  };
}

export class MessageStore {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async insert(input: NewMessage): Promise<StoredMessage> {
    const id = randomUUID();
    const receivedAt = Date.now();
    await this.db.query(
      `INSERT INTO aspectenant_messages (id, tenant_id, mailbox_id, folder, message_id, subject,
        from_address, from_name, to_json, cc_json, sent_at, received_at, size_bytes, seen, flagged,
        has_attachments, snippet, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        id,
        input.tenantId,
        input.mailboxId,
        input.folder,
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
        input.hasAttachments ? 1 : 0,
        input.snippet,
        Buffer.from(input.raw),
      ],
    );
    const { raw: _raw, ...rest } = input;
    return { ...rest, id, receivedAt, sizeBytes: input.raw.byteLength };
  }

  async exists(mailboxId: string, messageId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM aspectenant_messages WHERE mailbox_id = $1 AND message_id = $2 LIMIT 1`,
      [mailboxId, messageId],
    );
    return result.rows.length > 0;
  }

  async list(
    mailboxId: string,
    folder: MailFolder,
    options: { limit: number; before?: number; search?: string },
  ): Promise<StoredMessage[]> {
    const params: unknown[] = [mailboxId, folder];
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
    for (const folder of MAIL_FOLDERS) out[folder] = { total: 0, unread: 0 };
    for (const row of result.rows) {
      out[String(row.folder)] = { total: num(row.total), unread: num(row.unread ?? 0) };
    }
    return out;
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

  async update(
    id: string,
    patch: { seen?: boolean; flagged?: boolean; folder?: MailFolder },
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.seen !== undefined) {
      params.push(patch.seen ? 1 : 0);
      sets.push(`seen = $${params.length}`);
    }
    if (patch.flagged !== undefined) {
      params.push(patch.flagged ? 1 : 0);
      sets.push(`flagged = $${params.length}`);
    }
    if (patch.folder !== undefined) {
      params.push(patch.folder);
      sets.push(`folder = $${params.length}`);
    }
    if (sets.length === 0) return;
    params.push(id);
    await this.db.query(
      `UPDATE aspectenant_messages SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.query(`DELETE FROM aspectenant_messages WHERE id = $1`, [id]);
  }

  async emptyFolder(mailboxId: string, folder: MailFolder): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM aspectenant_messages WHERE mailbox_id = $1 AND folder = $2`,
      [mailboxId, folder],
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
