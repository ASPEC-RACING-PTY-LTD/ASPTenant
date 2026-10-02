import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DbError, DbErrorCode } from './errors.js';
import { noopLogger } from './instrumentation.js';
import { tableExists, tableName, withRunLock } from './lock.js';
import { checksumSql } from './migrations.js';
import type { Clock, LoggerLike, SqlClient, SqlDialect } from './ports.js';
import { safeErrorMessage } from './redact.js';

export interface SeedDefinition {
  /** Unique id. Seeds run in id order. */
  id: string;
  /** SQL (parameterless, may contain several statements) or a function. */
  run: string | ((client: SqlClient) => Promise<void>);
  /** Recorded with the seed. Computed for SQL seeds. */
  checksum?: string;
}

export interface SeederOptions {
  seeds?: readonly SeedDefinition[];
  /** Directory of `.sql` seed files, run in file name order. */
  directory?: string;
  /** Prefix for the tracking table `<prefix>seeds`. Default `db_`. */
  tablePrefix?: string;
  /** Environment name checked by the production guard. Default `process.env.NODE_ENV`. */
  environment?: string;
  /** Allow seeding when the environment is `production`. Default false. */
  force?: boolean;
  lockTimeoutMs?: number;
  logger?: LoggerLike;
  clock?: Clock;
}

export interface SeedStatus {
  id: string;
  state: 'applied' | 'pending' | 'changed';
  appliedAt?: number;
}

export interface SeedRunResult {
  applied: string[];
  skipped: string[];
}

export interface Seeder {
  readonly table: string;
  status(): Promise<SeedStatus[]>;
  /**
   * Runs seeds that have not run before, each in its own transaction, and records them.
   * `only` limits the run to the given ids; `force` overrides the production guard.
   */
  run(options?: { only?: readonly string[]; force?: boolean }): Promise<SeedRunResult>;
}

const SEED_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

/** Loads `.sql` seed files from a directory (id = file name without `.sql`). */
export async function loadSeedFiles(directory: string): Promise<SeedDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    throw new DbError(
      DbErrorCode.SEED_FAILED,
      `Cannot read seeds directory ${directory}: ${safeErrorMessage(error)}`,
    );
  }
  const out: SeedDefinition[] = [];
  for (const file of entries.sort()) {
    if (!file.toLowerCase().endsWith('.sql')) continue;
    const sql = (await readFile(join(directory, file), 'utf8')).trim();
    if (sql === '') continue;
    out.push({ id: file.slice(0, -4), run: sql });
  }
  return out;
}

function tableDdl(table: string, dialect: SqlDialect): string {
  const big = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  return `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, checksum TEXT, applied_at ${big} NOT NULL)`;
}

/** Creates an idempotent seed runner with a production guard. */
export function createSeeder(client: SqlClient, options: SeederOptions = {}): Seeder {
  const table = tableName(options.tablePrefix ?? 'db_', 'seeds');
  const logger = options.logger ?? noopLogger;
  const clock = options.clock ?? { now: () => Date.now() };

  const load = async (): Promise<SeedDefinition[]> => {
    const defs: SeedDefinition[] = [];
    if (options.directory !== undefined) defs.push(...(await loadSeedFiles(options.directory)));
    if (options.seeds) defs.push(...options.seeds);
    const seen = new Set<string>();
    for (const def of defs) {
      if (typeof def.id !== 'string' || !SEED_ID.test(def.id)) {
        throw new DbError(DbErrorCode.SEED_FAILED, `Invalid seed id ${JSON.stringify(def.id)}`);
      }
      if (seen.has(def.id))
        throw new DbError(DbErrorCode.SEED_FAILED, `Duplicate seed id ${def.id}`);
      seen.add(def.id);
    }
    return defs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };

  const checksumOf = (def: SeedDefinition): string | null =>
    def.checksum ?? (typeof def.run === 'string' ? checksumSql(def.run) : null);

  return {
    table,

    async status() {
      const defs = await load();
      const rows = (await tableExists(client, table))
        ? (
            await client.query<{
              id: string;
              checksum: string | null;
              applied_at: number | string;
            }>(`SELECT id, checksum, applied_at FROM ${table}`)
          ).rows
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      return defs.map((def) => {
        const row = byId.get(def.id);
        if (!row) return { id: def.id, state: 'pending' as const };
        const current = checksumOf(def);
        return {
          id: def.id,
          state:
            row.checksum && current && row.checksum !== current
              ? ('changed' as const)
              : ('applied' as const),
          appliedAt: Number(row.applied_at),
        };
      });
    },

    async run(runOptions = {}) {
      const environment = options.environment ?? process.env.NODE_ENV;
      if (environment === 'production' && !(runOptions.force ?? options.force ?? false)) {
        throw new DbError(
          DbErrorCode.SEED_REFUSED,
          'Refusing to seed because the environment is production. Pass force: true (CLI: --force) to seed anyway.',
          { status: 403 },
        );
      }
      let defs = await load();
      if (runOptions.only) {
        const wanted = new Set(runOptions.only);
        const unknown = [...wanted].filter((id) => !defs.some((d) => d.id === id));
        if (unknown.length > 0)
          throw new DbError(DbErrorCode.SEED_FAILED, `Unknown seed(s): ${unknown.join(', ')}`);
        defs = defs.filter((d) => wanted.has(d.id));
      }
      return withRunLock(
        client,
        table,
        { timeoutMs: options.lockTimeoutMs ?? 60_000 },
        async (scope) => {
          await scope.conn.query(tableDdl(table, client.dialect));
          const applied: string[] = [];
          const skipped: string[] = [];
          for (const def of defs) {
            let ran = false;
            try {
              await scope.conn.transaction(async (tx) => {
                if (scope.transactionLockKey !== undefined) {
                  await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [
                    scope.transactionLockKey,
                  ]);
                }
                const exists = await tx.query(`SELECT id FROM ${table} WHERE id = $1`, [def.id]);
                if (exists.rows.length > 0) return;
                if (typeof def.run === 'string') await tx.query(def.run);
                else await def.run(tx);
                await tx.query(
                  `INSERT INTO ${table} (id, checksum, applied_at) VALUES ($1, $2, $3)`,
                  [def.id, checksumOf(def), clock.now()],
                );
                ran = true;
              });
            } catch (error) {
              logger.error({ id: def.id, err: safeErrorMessage(error) }, 'seed failed');
              throw new DbError(
                DbErrorCode.SEED_FAILED,
                `Seed ${def.id} failed: ${safeErrorMessage(error)}`,
                {
                  cause: error,
                  details: { id: def.id, completed: applied },
                },
              );
            }
            if (ran) {
              applied.push(def.id);
              logger.info({ id: def.id }, 'seed applied');
            } else skipped.push(def.id);
          }
          return { applied, skipped };
        },
      );
    },
  };
}
