import type { SqlClient } from '../../src/ports.js';
import type { OrgsStore } from '../../src/store.js';
import { createMemoryOrgsStore } from '../../src/stores/memory.js';
import { createSqlOrgsStore, migrate } from '../../src/stores/sql.js';
import { createPostgresClient, createSqliteClient } from './sql.js';

export const PG_URL = process.env.ASPEC_TEST_POSTGRES_URL;

export interface Backend {
  name: 'memory' | 'sqlite' | 'postgres';
  skip: boolean;
  init(): Promise<void>;
  fresh(): Promise<OrgsStore>;
  client(): SqlClient | undefined;
  close(): Promise<void>;
}

export function memoryBackend(): Backend {
  return {
    name: 'memory',
    skip: false,
    async init() {},
    async fresh() {
      return createMemoryOrgsStore();
    },
    client: () => undefined,
    async close() {},
  };
}

export function sqliteBackend(): Backend {
  let current: (SqlClient & { close(): void }) | undefined;
  return {
    name: 'sqlite',
    skip: false,
    async init() {},
    async fresh() {
      current?.close();
      current = createSqliteClient();
      await migrate(current);
      return createSqlOrgsStore(current);
    },
    client: () => current,
    async close() {
      current?.close();
      current = undefined;
    },
  };
}

export function postgresBackend(): Backend {
  let pgClient: Awaited<ReturnType<typeof createPostgresClient>> | undefined;
  return {
    name: 'postgres',
    skip: !PG_URL,
    async init() {
      pgClient = await createPostgresClient(PG_URL as string);
      await migrate(pgClient);
    },
    async fresh() {
      const c = pgClient as SqlClient;
      await c.query(
        'TRUNCATE orgs_organisations, orgs_memberships, orgs_teams, orgs_team_memberships, orgs_invitations, orgs_tenants',
      );
      return createSqlOrgsStore(c);
    },
    client: () => pgClient,
    async close() {
      await pgClient?.close();
    },
  };
}

export function allBackends(): Backend[] {
  return [memoryBackend(), sqliteBackend(), postgresBackend()];
}
