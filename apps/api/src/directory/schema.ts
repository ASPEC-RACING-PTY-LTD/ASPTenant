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

/** Tables migration 0005 put under row-level security. Fixed: later tables get their own. */
const RLS_0005_TABLES = [
  'aspectenant_groups',
  'aspectenant_group_members',
  'aspectenant_domains',
  'aspectenant_mailboxes',
  'aspectenant_mailbox_aliases',
  'aspectenant_mailbox_members',
  'aspectenant_applications',
  'aspectenant_settings',
  'aspectenant_messages',
  'aspectenant_mail_folders',
  'aspectenant_jobs',
] as const;

/** Tables that hold tenant data and carry `tenant_id`. Row-level security applies to each. */
export const TENANT_TABLES = [...RLS_0005_TABLES, 'aspectenant_service_credentials'] as const;

/**
 * Service credentials: IMAP and SMTP logins for applications and shared mailboxes, limited to
 * the mailboxes and permissions in `grants` and optionally to `allowed_ips`.
 */
/**
 * OpenID Connect: client settings on applications, and the provider's own store for
 * sessions, authorization codes, tokens and grants. The store is installation data keyed by
 * opaque ids; every record names its client, and clients belong to one tenant.
 */
function oidcSql(dialect: 'postgres' | 'sqlite'): string {
  const big = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  return `
ALTER TABLE aspectenant_applications ADD COLUMN client_type TEXT NOT NULL DEFAULT 'confidential';
ALTER TABLE aspectenant_applications ADD COLUMN secret_hash TEXT;
ALTER TABLE aspectenant_applications ADD COLUMN secret_created_at ${big};
ALTER TABLE aspectenant_applications ADD COLUMN require_assignment INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aspectenant_applications ADD COLUMN assignments TEXT NOT NULL DEFAULT '{"users":[],"groups":[]}';
ALTER TABLE aspectenant_applications ADD COLUMN require_mfa INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS aspectenant_oidc_store (
  model TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  grant_id TEXT,
  uid TEXT,
  user_code TEXT,
  expires_at ${big},
  consumed_at ${big},
  PRIMARY KEY (model, id)
);
CREATE INDEX IF NOT EXISTS aspectenant_oidc_store_grant_idx ON aspectenant_oidc_store (grant_id);
CREATE INDEX IF NOT EXISTS aspectenant_oidc_store_uid_idx ON aspectenant_oidc_store (uid);
CREATE INDEX IF NOT EXISTS aspectenant_oidc_store_expires_idx ON aspectenant_oidc_store (expires_at);
`;
}

function credentialsSql(dialect: 'postgres' | 'sqlite'): string {
  const big = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  return `
CREATE TABLE IF NOT EXISTS aspectenant_service_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  grants TEXT NOT NULL,
  allowed_ips TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  expires_at ${big},
  last_used_at ${big},
  last_used_ip TEXT,
  created_by TEXT,
  created_at ${big} NOT NULL,
  updated_at ${big} NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS aspectenant_service_credentials_username_uq
  ON aspectenant_service_credentials (username);
CREATE INDEX IF NOT EXISTS aspectenant_service_credentials_tenant_idx
  ON aspectenant_service_credentials (tenant_id);
`;
}

/** `tenant_id` of installation-wide settings (public URL, updates, backups, mail apps). */
export const PLATFORM_SCOPE = '__platform__';

/**
 * Binding that lets installation-level code (backup, restore, job discovery) see every
 * tenant's rows. Only code behind a platform permission or a system task binds it.
 */
export const ALL_TENANTS_SCOPE = '*';

/** Name of the row-level security policy on every tenant table. */
export const RLS_POLICY = 'aspectenant_tenant_isolation';

function rowLevelSecuritySql(tables: readonly string[]): string {
  const bound = `NULLIF(current_setting('app.tenant_id', true), '')`;
  const rule = `(tenant_id = ${bound} OR ${bound} = '${ALL_TENANTS_SCOPE}')`;
  return tables
    .map(
      (table) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ${RLS_POLICY} ON ${table};
CREATE POLICY ${RLS_POLICY} ON ${table} FOR ALL TO PUBLIC USING ${rule} WITH CHECK ${rule};`,
    )
    .join('\n');
}

/** Settings keys that belong to the installation, not to one tenant. */
export const PLATFORM_SETTING_KEYS = [
  'general',
  'updates',
  'backup',
  'mail-clients',
  'domainconnect',
] as const;

/**
 * Fills tenant columns and moves installation settings for rows written by single-tenant
 * releases. Runs in the migration and again after restoring an older backup.
 */
export function tenancyBackfillSql(): string[] {
  const keys = PLATFORM_SETTING_KEYS.map((key) => `'${key}'`).join(', ');
  return [
    `UPDATE aspectenant_group_members SET tenant_id = (
  SELECT g.tenant_id FROM aspectenant_groups g WHERE g.id = aspectenant_group_members.group_id
) WHERE tenant_id = ''`,
    `UPDATE aspectenant_mailbox_aliases SET tenant_id = (
  SELECT m.tenant_id FROM aspectenant_mailboxes m WHERE m.id = aspectenant_mailbox_aliases.mailbox_id
) WHERE tenant_id = ''`,
    `INSERT INTO aspectenant_settings (tenant_id, key, value, updated_at)
  SELECT '${PLATFORM_SCOPE}', key, value, updated_at FROM aspectenant_settings
  WHERE tenant_id = 'default' AND key IN (${keys})
  ON CONFLICT DO NOTHING`,
    `DELETE FROM aspectenant_settings WHERE tenant_id = 'default' AND key IN (${keys})`,
  ];
}

function tenancySql(): string {
  return `
ALTER TABLE aspectenant_group_members ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS aspectenant_group_members_tenant_idx
  ON aspectenant_group_members (tenant_id, group_id);

ALTER TABLE aspectenant_mailbox_aliases ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS aspectenant_mailbox_aliases_tenant_idx
  ON aspectenant_mailbox_aliases (tenant_id, mailbox_id);

CREATE UNIQUE INDEX IF NOT EXISTS aspectenant_domains_verified_uq
  ON aspectenant_domains (hostname) WHERE status = 'verified';

DROP INDEX IF EXISTS aspectenant_mailboxes_address_uq;
CREATE UNIQUE INDEX IF NOT EXISTS aspectenant_mailboxes_address_global_uq
  ON aspectenant_mailboxes (primary_address);

${tenancyBackfillSql().join(';\n')};
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
      {
        id: '0004_tenancy',
        postgres: tenancySql(),
        sqlite: tenancySql(),
      },
      {
        id: '0005_row_level_security',
        postgres: rowLevelSecuritySql(RLS_0005_TABLES),
        sqlite: 'SELECT 1;',
      },
      {
        id: '0006_service_credentials',
        postgres: `${credentialsSql('postgres')}
${rowLevelSecuritySql(['aspectenant_service_credentials'])}`,
        sqlite: credentialsSql('sqlite'),
      },
      {
        id: '0007_oidc',
        postgres: oidcSql('postgres'),
        sqlite: oidcSql('sqlite'),
      },
    ],
  });
  await migrator.up();
}
