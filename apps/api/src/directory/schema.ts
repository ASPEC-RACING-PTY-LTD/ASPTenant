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

export async function migrateDirectory(client: SqlClient): Promise<void> {
  const migrator = createMigrator(client, {
    tablePrefix: 'aspectenant_',
    migrations: [
      {
        id: '0001_directory',
        postgres: schemaSql('postgres'),
        sqlite: schemaSql('sqlite'),
      },
    ],
  });
  await migrator.up();
}
