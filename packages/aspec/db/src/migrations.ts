import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DbError, DbErrorCode } from './errors.js';
import { noopLogger } from './instrumentation.js';
import { type LockScope, tableExists, tableName, withRunLock } from './lock.js';
import type { Clock, LoggerLike, SqlClient, SqlDialect } from './ports.js';
import { safeErrorMessage } from './redact.js';
import { splitStatements } from './sql-text.js';

/** SQL text, or a function that receives the migration's client. */
export type MigrationStep = string | ((client: SqlClient) => Promise<void>);

export interface MigrationDefinition {
  /** Unique id starting with a number, for example `0001_create_users`. Determines order. */
  id: string;
  /** Human-readable name. Default: the id without its numeric prefix. */
  name?: string;
  /** Dialect-independent up step. Use either `up` or `postgres`/`sqlite`. */
  up?: MigrationStep;
  down?: MigrationStep;
  /** Up SQL for PostgreSQL (the `{ id, postgres, sqlite }` form used by ASPEC module stores). */
  postgres?: string;
  /** Up SQL for SQLite. */
  sqlite?: string;
  /** Run inside a transaction. Default true. Set false for `CREATE INDEX CONCURRENTLY`. */
  transaction?: boolean;
  /**
   * Checksum recorded when applied. Computed from SQL automatically; function steps have no
   * checksum unless you set one (bump it when the function changes meaning).
   */
  checksum?: string;
}

export type MigrationState = 'applied' | 'pending' | 'changed' | 'missing';

export interface MigrationStatus {
  id: string;
  name: string;
  state: MigrationState;
  appliedAt?: number;
  /** Checksum of the current source (null for function steps without an explicit checksum). */
  checksum: string | null;
  /** Checksum recorded when the migration was applied. */
  appliedChecksum?: string | null;
  transaction: boolean;
  reversible: boolean;
}

export interface MigrationRunResult {
  /** Ids applied (up) or reverted (down), in execution order. */
  migrations: string[];
  /** Ids another runner applied or reverted while this one waited. */
  skipped: string[];
}

export interface MigratorOptions {
  /** Programmatic migrations. Combined with `directory`. */
  migrations?: readonly MigrationDefinition[];
  /** Directory of `NNNN_name.sql` files. */
  directory?: string;
  /** Prefix for the tracking table `<prefix>schema_migrations`. Default `db_`. */
  tablePrefix?: string;
  /** How long to wait for another runner's lock. Default 60000 ms. */
  lockTimeoutMs?: number;
  /** Refuse to run when an applied migration's checksum changed. Default true. */
  validateChecksums?: boolean;
  logger?: LoggerLike;
  clock?: Clock;
}

export interface Migrator {
  readonly table: string;
  /** Every known migration with its state. Does not take the lock. */
  status(): Promise<MigrationStatus[]>;
  /** Applies pending migrations in order, optionally up to and including `to`. */
  up(options?: { to?: string }): Promise<MigrationRunResult>;
  /** Reverts the last `steps` applied migrations (default 1), or every migration applied after `to`. */
  down(options?: { steps?: number; to?: string }): Promise<MigrationRunResult>;
  /** Alias of `down`. */
  rollback(options?: { steps?: number; to?: string }): Promise<MigrationRunResult>;
}

interface Resolved {
  id: string;
  name: string;
  order: bigint;
  up: MigrationStep;
  down?: MigrationStep;
  transaction: boolean;
  checksum: string | null;
}

interface AppliedRow {
  id: string;
  name: string;
  checksum: string | null;
  seq: number;
  applied_at: number | string;
}

const ID_PATTERN = /^(\d{1,20})_[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const FILE_PATTERN = /^(\d{1,20})_([A-Za-z0-9][A-Za-z0-9_.-]{0,199})\.sql$/;
const DIRECTIVE = /^\s*--\s*migrate:(up|down|no-transaction)\b(.*)$/i;

function invalid(message: string, details?: unknown): DbError {
  return new DbError(DbErrorCode.MIGRATION_INVALID, message, { details });
}

/** SHA-256 of SQL with line endings normalised, so Windows checkouts produce the same value. */
export function checksumSql(sql: string): string {
  const normalised = sql.replace(/\r\n?/g, '\n').trim();
  return createHash('sha256').update(normalised).digest('hex');
}

export interface ParsedMigrationSql {
  up: string;
  down?: string;
  transaction: boolean;
}

/**
 * Parses a migration file. The up section starts at the top (or after `-- migrate:up`), the
 * optional down section after `-- migrate:down`. `-- migrate:no-transaction` (or
 * `-- migrate:up transaction:false`) disables the transaction wrapper.
 */
export function parseMigrationSql(content: string): ParsedMigrationSql {
  const up: string[] = [];
  const down: string[] = [];
  let section: 'up' | 'down' = 'up';
  let transaction = true;
  let sawDown = false;
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const directive = DIRECTIVE.exec(line);
    if (directive) {
      const kind = (directive[1] as string).toLowerCase();
      if (kind === 'up') {
        section = 'up';
        if (/transaction:\s*false/i.test(directive[2] ?? '')) transaction = false;
      } else if (kind === 'down') {
        section = 'down';
        sawDown = true;
      } else transaction = false;
      continue;
    }
    (section === 'up' ? up : down).push(line);
  }
  const out: ParsedMigrationSql = { up: up.join('\n').trim(), transaction };
  const downSql = down.join('\n').trim();
  if (sawDown && downSql !== '') out.down = downSql;
  return out;
}

/** Loads `NNNN_name.sql` migrations from a directory, sorted by numeric prefix. */
export async function loadMigrationFiles(directory: string): Promise<MigrationDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    throw invalid(`Cannot read migrations directory ${directory}: ${safeErrorMessage(error)}`);
  }
  const out: MigrationDefinition[] = [];
  for (const file of entries.sort()) {
    if (!file.toLowerCase().endsWith('.sql')) continue;
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw invalid(
        `Migration file ${file} must be named NNNN_name.sql (digits, underscore, name)`,
      );
    }
    const parsed = parseMigrationSql(await readFile(join(directory, file), 'utf8'));
    if (parsed.up === '') throw invalid(`Migration file ${file} has an empty up section`);
    const def: MigrationDefinition = {
      id: file.slice(0, -4),
      name: match[2] as string,
      up: parsed.up,
      transaction: parsed.transaction,
    };
    if (parsed.down !== undefined) def.down = parsed.down;
    out.push(def);
  }
  return out;
}

function resolve(defs: readonly MigrationDefinition[], dialect: SqlDialect): Resolved[] {
  const seen = new Set<string>();
  const out: Resolved[] = [];
  for (const def of defs) {
    const match = typeof def.id === 'string' ? ID_PATTERN.exec(def.id) : null;
    if (!match) {
      throw invalid(
        `Migration id ${JSON.stringify(def.id)} must start with digits and an underscore, for example 0001_init`,
      );
    }
    if (seen.has(def.id)) throw invalid(`Duplicate migration id ${def.id}`);
    seen.add(def.id);
    const dialectSql = dialect === 'postgres' ? def.postgres : def.sqlite;
    const hasDialectForm = def.postgres !== undefined || def.sqlite !== undefined;
    if (def.up !== undefined && hasDialectForm)
      throw invalid(`Migration ${def.id} sets both up and postgres/sqlite`);
    const up = def.up ?? dialectSql;
    if (up === undefined || (typeof up === 'string' && up.trim() === '')) {
      throw invalid(`Migration ${def.id} has no up step for ${dialect}`);
    }
    if (typeof up !== 'string' && typeof up !== 'function')
      throw invalid(`Migration ${def.id} up must be SQL or a function`);
    const resolved: Resolved = {
      id: def.id,
      name: def.name ?? def.id.slice((match[1] as string).length + 1),
      order: BigInt(match[1] as string),
      up,
      transaction: def.transaction ?? true,
      checksum: def.checksum ?? (typeof up === 'string' ? checksumSql(up) : null),
    };
    if (def.down !== undefined) resolved.down = def.down;
    out.push(resolved);
  }
  return out.sort((a, b) =>
    a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

async function runStep(
  conn: SqlClient,
  step: MigrationStep,
  inTransaction: boolean,
): Promise<void> {
  if (typeof step === 'function') {
    await step(conn);
    return;
  }
  if (!inTransaction && conn.dialect === 'postgres') {
    // A multi-statement simple query runs in an implicit transaction, which statements such
    // as CREATE INDEX CONCURRENTLY reject; run them one at a time instead.
    for (const statement of splitStatements(step, 'postgres')) await conn.query(statement);
    return;
  }
  await conn.query(step);
}

function tableDdl(table: string, dialect: SqlDialect): string {
  const big = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  return `CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT,
  seq INTEGER NOT NULL,
  applied_at ${big} NOT NULL,
  duration_ms INTEGER NOT NULL
)`;
}

/**
 * Creates a migration runner for any SqlClient. Clients from this package get a session
 * advisory lock (PostgreSQL) or the connection queue (SQLite); other SqlClients use
 * per-transaction advisory locks on PostgreSQL.
 */
export function createMigrator(client: SqlClient, options: MigratorOptions = {}): Migrator {
  const table = tableName(options.tablePrefix ?? 'db_', 'schema_migrations');
  const logger = options.logger ?? noopLogger;
  const clock = options.clock ?? { now: () => Date.now() };
  const lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  const validateChecksums = options.validateChecksums ?? true;

  const load = async (): Promise<Resolved[]> => {
    const defs: MigrationDefinition[] = [];
    if (options.directory !== undefined)
      defs.push(...(await loadMigrationFiles(options.directory)));
    if (options.migrations) defs.push(...options.migrations);
    return resolve(defs, client.dialect);
  };

  const readApplied = async (conn: SqlClient): Promise<AppliedRow[]> => {
    const result = await conn.query<AppliedRow>(
      `SELECT id, name, checksum, seq, applied_at FROM ${table} ORDER BY seq`,
    );
    return result.rows;
  };

  const verify = (defs: Resolved[], applied: AppliedRow[]): void => {
    if (!validateChecksums) return;
    const byId = new Map(defs.map((d) => [d.id, d]));
    const changed = applied
      .map((row) => ({ row, def: byId.get(row.id) }))
      .filter(
        ({ row, def }) => def && row.checksum && def.checksum && row.checksum !== def.checksum,
      )
      .map(({ row, def }) => ({
        id: row.id,
        applied: row.checksum,
        current: def?.checksum ?? null,
      }));
    if (changed.length > 0) {
      throw new DbError(
        DbErrorCode.MIGRATION_CHECKSUM_MISMATCH,
        `Applied migration(s) changed after they ran: ${changed.map((c) => c.id).join(', ')}. Restore the original migration and add a new one for the change.`,
        { status: 409, details: { migrations: changed } },
      );
    }
    const known = new Set(defs.map((d) => d.id));
    const missing = applied.filter((row) => !known.has(row.id)).map((row) => row.id);
    if (missing.length > 0)
      logger.warn({ migrations: missing }, 'applied migrations are missing from the source');
  };

  const inTransaction = async (
    scope: LockScope,
    fn: (tx: SqlClient) => Promise<void>,
  ): Promise<void> => {
    await scope.conn.transaction(async (tx) => {
      if (scope.transactionLockKey !== undefined) {
        await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [scope.transactionLockKey]);
      }
      await fn(tx);
    });
  };

  const isRecorded = async (conn: SqlClient, id: string): Promise<boolean> =>
    (await conn.query(`SELECT id FROM ${table} WHERE id = $1`, [id])).rows.length > 0;

  const record = async (conn: SqlClient, m: Resolved, durationMs: number): Promise<void> => {
    const next = await conn.query<{ next: number | string }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ${table}`,
    );
    await conn.query(
      `INSERT INTO ${table} (id, name, checksum, seq, applied_at, duration_ms) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        m.id,
        m.name,
        m.checksum,
        Number(next.rows[0]?.next ?? 1),
        clock.now(),
        Math.round(durationMs),
      ],
    );
  };

  const failure = (
    m: Resolved,
    direction: 'up' | 'down',
    error: unknown,
    done: string[],
  ): DbError =>
    error instanceof DbError && error.code === DbErrorCode.MIGRATION_INVALID
      ? error
      : new DbError(
          DbErrorCode.MIGRATION_FAILED,
          `Migration ${m.id} (${direction}) failed: ${safeErrorMessage(error)}`,
          {
            cause: error,
            details: { id: m.id, direction, completed: done },
          },
        );

  const ensureTable = async (scope: LockScope): Promise<void> => {
    if (scope.transactionLockKey !== undefined) {
      await inTransaction(scope, async (tx) => {
        await tx.query(tableDdl(table, client.dialect));
      });
    } else {
      await scope.conn.query(tableDdl(table, client.dialect));
    }
  };

  const migrator: Migrator = {
    table,

    async status() {
      const defs = await load();
      const applied = (await tableExists(client, table)) ? await readApplied(client) : [];
      const appliedById = new Map(applied.map((row) => [row.id, row]));
      const out: MigrationStatus[] = defs.map((def) => {
        const row = appliedById.get(def.id);
        const status: MigrationStatus = {
          id: def.id,
          name: def.name,
          state: 'pending',
          checksum: def.checksum,
          transaction: def.transaction,
          reversible: def.down !== undefined,
        };
        if (row) {
          status.appliedAt = Number(row.applied_at);
          status.appliedChecksum = row.checksum;
          status.state =
            row.checksum && def.checksum && row.checksum !== def.checksum ? 'changed' : 'applied';
        }
        return status;
      });
      const known = new Set(defs.map((d) => d.id));
      for (const row of applied) {
        if (known.has(row.id)) continue;
        out.push({
          id: row.id,
          name: row.name,
          state: 'missing',
          appliedAt: Number(row.applied_at),
          checksum: null,
          appliedChecksum: row.checksum,
          transaction: true,
          reversible: false,
        });
      }
      return out;
    },

    async up(upOptions = {}) {
      const defs = await load();
      if (upOptions.to !== undefined && !defs.some((d) => d.id === upOptions.to)) {
        throw invalid(`Unknown migration ${upOptions.to}`);
      }
      return withRunLock(client, table, { timeoutMs: lockTimeoutMs }, async (scope) => {
        await ensureTable(scope);
        const applied = await readApplied(scope.conn);
        verify(defs, applied);
        const appliedIds = new Set(applied.map((row) => row.id));
        const limit =
          upOptions.to !== undefined
            ? defs.findIndex((d) => d.id === upOptions.to)
            : defs.length - 1;
        const pending = defs.slice(0, limit + 1).filter((d) => !appliedIds.has(d.id));
        const latest = applied.reduce<bigint>((max, row) => {
          const m = ID_PATTERN.exec(row.id);
          const order = m ? BigInt(m[1] as string) : 0n;
          return order > max ? order : max;
        }, -1n);
        const done: string[] = [];
        const skipped: string[] = [];
        for (const m of pending) {
          if (m.order < latest)
            logger.warn({ id: m.id }, 'applying a migration older than the latest applied one');
          const started = performance.now();
          try {
            if (m.transaction) {
              let ran = false;
              await inTransaction(scope, async (tx) => {
                if (await isRecorded(tx, m.id)) return;
                await runStep(tx, m.up, true);
                await record(tx, m, performance.now() - started);
                ran = true;
              });
              if (!ran) {
                skipped.push(m.id);
                continue;
              }
            } else {
              if (scope.transactionLockKey !== undefined) {
                throw invalid(
                  `Migration ${m.id} disables transactions, which needs a client created by @aspec/db for locking`,
                );
              }
              if (await isRecorded(scope.conn, m.id)) {
                skipped.push(m.id);
                continue;
              }
              await runStep(scope.conn, m.up, false);
              await record(scope.conn, m, performance.now() - started);
            }
          } catch (error) {
            logger.error({ id: m.id, err: safeErrorMessage(error) }, 'migration failed');
            throw failure(m, 'up', error, done);
          }
          done.push(m.id);
          logger.info(
            { id: m.id, durationMs: Math.round(performance.now() - started) },
            'migration applied',
          );
        }
        return { migrations: done, skipped };
      });
    },

    async down(downOptions = {}) {
      const defs = await load();
      const steps = downOptions.steps ?? 1;
      if (downOptions.to === undefined && (!Number.isInteger(steps) || steps < 1)) {
        throw invalid('steps must be a positive integer');
      }
      return withRunLock(client, table, { timeoutMs: lockTimeoutMs }, async (scope) => {
        if (!(await tableExists(scope.conn, table))) return { migrations: [], skipped: [] };
        const applied = await readApplied(scope.conn);
        verify(defs, applied);
        const newestFirst = [...applied].reverse();
        let targets: AppliedRow[];
        if (downOptions.to !== undefined) {
          const anchor = applied.find((row) => row.id === downOptions.to);
          if (!anchor) throw invalid(`Migration ${downOptions.to} is not applied`);
          targets = newestFirst.filter((row) => Number(row.seq) > Number(anchor.seq));
        } else {
          targets = newestFirst.slice(0, steps);
        }
        const byId = new Map(defs.map((d) => [d.id, d]));
        const irreversible = targets
          .filter((row) => byId.get(row.id)?.down === undefined)
          .map((row) => row.id);
        if (irreversible.length > 0) {
          throw new DbError(
            DbErrorCode.MIGRATION_IRREVERSIBLE,
            `Cannot roll back ${irreversible.join(', ')}: no down step is available`,
            { status: 409, details: { migrations: irreversible } },
          );
        }
        const done: string[] = [];
        const skipped: string[] = [];
        for (const row of targets) {
          const m = byId.get(row.id) as Resolved;
          const downStep = m.down as MigrationStep;
          const started = performance.now();
          try {
            if (m.transaction) {
              let ran = false;
              await inTransaction(scope, async (tx) => {
                if (!(await isRecorded(tx, m.id))) return;
                await runStep(tx, downStep, true);
                await tx.query(`DELETE FROM ${table} WHERE id = $1`, [m.id]);
                ran = true;
              });
              if (!ran) {
                skipped.push(m.id);
                continue;
              }
            } else {
              if (scope.transactionLockKey !== undefined) {
                throw invalid(
                  `Migration ${m.id} disables transactions, which needs a client created by @aspec/db for locking`,
                );
              }
              await runStep(scope.conn, downStep, false);
              await scope.conn.query(`DELETE FROM ${table} WHERE id = $1`, [m.id]);
            }
          } catch (error) {
            logger.error({ id: m.id, err: safeErrorMessage(error) }, 'migration rollback failed');
            throw failure(m, 'down', error, done);
          }
          done.push(m.id);
          logger.info(
            { id: m.id, durationMs: Math.round(performance.now() - started) },
            'migration reverted',
          );
        }
        return { migrations: done, skipped };
      });
    },

    rollback(downOptions) {
      return migrator.down(downOptions);
    },
  };
  return migrator;
}

function timestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * Creates `<directory>/<YYYYMMDDHHMMSS>_<name>.sql` with up and down sections. The name is
 * reduced to lowercase letters, digits and underscores. Never overwrites a file.
 */
export async function createMigrationFile(
  directory: string,
  name: string,
  options: { clock?: Clock } = {},
): Promise<{ id: string; path: string }> {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
  if (slug === '') throw invalid('Migration name must contain letters or digits');
  const id = `${timestamp((options.clock ?? { now: () => Date.now() }).now())}_${slug}`;
  const path = join(directory, `${id}.sql`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path, '-- migrate:up\n\n\n-- migrate:down\n\n', { flag: 'wx' });
  } catch (error) {
    throw invalid(`Cannot create ${path}: ${safeErrorMessage(error)}`);
  }
  return { id, path };
}
