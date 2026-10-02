import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { ClientOptions, Database } from '../src/client.js';
import { createSqliteClient } from '../src/drivers/better-sqlite3.js';
import { createNodeSqliteClient } from '../src/drivers/node-sqlite.js';
import { createPostgresClient, type PostgresClientOptions } from '../src/drivers/postgres.js';

export const PG_URL = process.env.ASPEC_TEST_POSTGRES_URL;

export function tempDir(prefix = 'aspec-db-'): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => {
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Windows may hold WAL files briefly; temp directories are cleaned by the OS.
      }
    },
  };
}

export function randomSchema(): string {
  return `test_db_${randomBytes(6).toString('hex')}`;
}

export async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createSchema(schema: string): Promise<void> {
  await withAdmin((c) => c.query(`CREATE SCHEMA ${schema}`));
}

export async function dropSchema(schema: string): Promise<void> {
  await withAdmin((c) => c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
}

export function pgClient(schema: string, options: Partial<PostgresClientOptions> = {}): Database {
  return createPostgresClient({ url: PG_URL as string, searchPath: [schema], pg, ...options });
}

export interface ClientFactory {
  name: string;
  dialect: 'postgres' | 'sqlite';
  file: boolean;
  enabled: boolean;
  /** Creates a fresh, isolated database. */
  create(options?: ClientOptions): Promise<{ db: Database; cleanup(): Promise<void> }>;
}

function sqliteFactory(
  name: string,
  file: boolean,
  make: (filename: string, options: ClientOptions) => Database,
): ClientFactory {
  return {
    name,
    dialect: 'sqlite',
    file,
    enabled: true,
    async create(options = {}) {
      const dir = file ? tempDir() : undefined;
      const db = make(dir ? join(dir.path, 'test.db') : ':memory:', options);
      await db.connect();
      return {
        db,
        async cleanup() {
          await db.close();
          dir?.cleanup();
        },
      };
    },
  };
}

export const factories: ClientFactory[] = [
  sqliteFactory('better-sqlite3 (memory)', false, (filename, o) =>
    createSqliteClient({ filename, ...o }),
  ),
  sqliteFactory('better-sqlite3 (file)', true, (filename, o) =>
    createSqliteClient({ filename, ...o }),
  ),
  sqliteFactory('node:sqlite (memory)', false, (filename, o) =>
    createNodeSqliteClient({ filename, ...o }),
  ),
  sqliteFactory('node:sqlite (file)', true, (filename, o) =>
    createNodeSqliteClient({ filename, ...o }),
  ),
  {
    name: 'pg (PostgreSQL)',
    dialect: 'postgres',
    file: false,
    enabled: Boolean(PG_URL),
    async create(options = {}) {
      const schema = randomSchema();
      await createSchema(schema);
      const db = pgClient(schema, options);
      await db.connect();
      return {
        db,
        async cleanup() {
          await db.close();
          await dropSchema(schema);
        },
      };
    },
  },
];

export function recordingLogger() {
  const entries: Array<{ level: string; obj: Record<string, unknown>; msg: string | undefined }> =
    [];
  const make = (level: string) => (obj: Record<string, unknown>, msg?: string) => {
    entries.push({ level, obj, msg });
  };
  return {
    entries,
    logger: { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') },
  };
}
