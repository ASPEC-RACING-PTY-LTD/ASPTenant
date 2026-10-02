import type { SqlClient } from '../../src/ports.js';
import type { UsersStore } from '../../src/store.js';
import { createMemoryUsersStore } from '../../src/stores/memory.js';
import { createSqlUsersStore, migrate } from '../../src/stores/sql.js';
import { createPostgresClient, createSqliteClient } from './sql.js';

export const PG_URL = process.env.ASPEC_TEST_POSTGRES_URL;

export interface Backend {
  name: 'memory' | 'sqlite' | 'postgres';
  skip: boolean;
  /** Called in beforeAll. */
  init(): Promise<void>;
  /** Returns a fresh, empty store. */
  fresh(): Promise<UsersStore>;
  client(): SqlClient | undefined;
  close(): Promise<void>;
}

export function memoryBackend(): Backend {
  return {
    name: 'memory',
    skip: false,
    async init() {},
    async fresh() {
      return createMemoryUsersStore();
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
      return createSqlUsersStore(current);
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
        'TRUNCATE users_accounts, users_activation_tokens, users_invitations, users_activity',
      );
      return createSqlUsersStore(c);
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
