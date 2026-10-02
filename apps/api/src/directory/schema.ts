import { createMigrator, type SqlClient } from '@aspec/db';

function schemaSql(dialect: 'postgres' | 'sqlite'): string {
  const big = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  return `
CREATE TABLE IF NOT EXISTS aspectenant_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS aspectenant_groups_slug_uq
  ON aspectenant_groups (tenant_id, slug);

CREATE TABLE IF NOT EXISTS aspectenant_group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_at ${big} NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS aspectenant_group_members_user_idx
  ON aspectenant_group_members (user_id);

CREATE TABLE IF NOT EXISTS aspectenant_domains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  status TEXT NOT NULL,
  is_primary INTEGER NOT NULL,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL,
  verified_at ${big}
);
CREATE UNIQUE INDEX IF NOT EXISTS aspectenant_domains_host_uq
  ON aspectenant_domains (tenant_id, hostname);

CREATE TABLE IF NOT EXISTS aspectenant_mailboxes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  primary_address TEXT NOT NULL,
  kind TEXT NOT NULL,
  display_name TEXT,
  quota_bytes ${big},
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS aspectenant_mailboxes_address_uq
  ON aspectenant_mailboxes (tenant_id, primary_address);
CREATE UNIQUE INDEX IF NOT EXISTS aspectenant_mailboxes_user_uq
  ON aspectenant_mailboxes (tenant_id, user_id)
  WHERE user_id IS NOT NULL AND kind = 'user';

CREATE TABLE IF NOT EXISTS aspectenant_mailbox_aliases (
  mailbox_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  created_at ${big} NOT NULL,
  PRIMARY KEY (mailbox_id, alias)
);
CREATE UNIQUE INDEX IF NOT EXISTS aspectenant_mailbox_aliases_alias_uq
  ON aspectenant_mailbox_aliases (alias);

CREATE TABLE IF NOT EXISTS aspectenant_applications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS aspectenant_applications_client_uq
  ON aspectenant_applications (client_id);
`;
}

function mailSql(dialect: 'postgres' | 'sqlite'): string {
  const big = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  const blob = dialect === 'postgres' ? 'BYTEA' : 'BLOB';
  return `
ALTER TABLE aspectenant_groups ADD COLUMN email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS aspectenant_groups_email_uq
  ON aspectenant_groups (tenant_id, email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS aspectenant_settings (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at ${big} NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS aspectenant_mailbox_members (
  tenant_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_at ${big} NOT NULL,
  PRIMARY KEY (mailbox_id, user_id)
);

CREATE TABLE IF NOT EXISTS aspectenant_messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  message_id TEXT,
  subject TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  sent_at ${big},
  received_at ${big} NOT NULL,
  size_bytes ${big} NOT NULL,
  seen INTEGER NOT NULL,
  flagged INTEGER NOT NULL,
  has_attachments INTEGER NOT NULL,
  snippet TEXT NOT NULL,
  raw ${blob} NOT NULL
);
CREATE INDEX IF NOT EXISTS aspectenant_messages_folder_idx
  ON aspectenant_messages (mailbox_id, folder, received_at);
CREATE INDEX IF NOT EXISTS aspectenant_messages_msgid_idx
  ON aspectenant_messages (mailbox_id, message_id);
`;
}

function imapSql(dialect: 'postgres' | 'sqlite'): string {
  const big = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  return `
CREATE TABLE IF NOT EXISTS aspectenant_mail_folders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  name TEXT NOT NULL,
  special_use TEXT,
  uid_validity ${big} NOT NULL,
  uid_next ${big} NOT NULL,
  subscribed INTEGER NOT NULL,
  created_at ${big} NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS aspectenant_mail_folders_name_uq
  ON aspectenant_mail_folders (mailbox_id, name);
ALTER TABLE aspectenant_messages ADD COLUMN uid ${big};
ALTER TABLE aspectenant_messages ADD COLUMN answered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aspectenant_messages ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aspectenant_messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aspectenant_messages ADD COLUMN import_key TEXT;
UPDATE aspectenant_messages SET folder = 'INBOX' WHERE folder = 'inbox';
UPDATE aspectenant_messages SET folder = 'Sent' WHERE folder = 'sent';
UPDATE aspectenant_messages SET folder = 'Archive' WHERE folder = 'archive';
UPDATE aspectenant_messages SET folder = 'Junk' WHERE folder = 'junk';
UPDATE aspectenant_messages SET folder = 'Trash' WHERE folder = 'trash';
CREATE INDEX IF NOT EXISTS aspectenant_messages_uid_idx
  ON aspectenant_messages (mailbox_id, folder, uid);
CREATE UNIQUE INDEX IF NOT EXISTS aspectenant_messages_import_uq
  ON aspectenant_messages (mailbox_id, import_key) WHERE import_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS aspectenant_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  progress TEXT NOT NULL,
  error TEXT,
  created_by TEXT,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL,
  finished_at ${big}
);
CREATE INDEX IF NOT EXISTS aspectenant_jobs_kind_idx ON aspectenant_jobs (kind, created_at);
`;
}

export async function migrateDirectory(client: SqlClient): Promise<void> {
  const migrator = createMigrator(client, {
    tablePrefix: 'aspectenant_',
    migrations: [
      {
        id: '0001_directory',
        postgres: schemaSql('postgres'),
        sqlite: schemaSql('sqlite'),
      },
      {
        id: '0002_mail',
        postgres: mailSql('postgres'),
        sqlite: mailSql('sqlite'),
      },
      {
        id: '0003_imap_jobs',
        postgres: imapSql('postgres'),
        sqlite: imapSql('sqlite'),
      },
    ],
  });
  await migrator.up();
}
