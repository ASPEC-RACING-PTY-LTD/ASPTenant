#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Database } from './client.js';
import type { SqliteDriverName } from './config.js';
import { createDatabase } from './database.js';
import { DbError, DbErrorCode } from './errors.js';
import { createMigrationFile, createMigrator } from './migrations.js';
import type { LoggerLike } from './ports.js';
import { redactText } from './redact.js';
import { createSeeder } from './seeding.js';

/** Exit codes: 0 success, 1 runtime failure, 2 usage or configuration error, 3 refused. */
const EXIT = { ok: 0, failure: 1, usage: 2, refused: 3 } as const;

const HELP = `Usage: aspec-db <command> [options]

Commands:
  migrate              Apply pending migrations
  status               Show migration status
  rollback             Revert applied migrations (default: the last one)
  create <name>        Create a new timestamped migration file
  seed                 Run seeds that have not run yet

Options:
  --url <url>          Connection URL (default: DATABASE_URL)
  --dir <path>         Migrations directory (default: ./migrations)
  --seeds <path>       Seeds directory (default: ./seeds)
  --table-prefix <p>   Tracking table prefix (default: db_)
  --to <id>            migrate: stop after this id; rollback: revert everything after it
  --steps <n>          rollback: number of migrations to revert (default 1)
  --only <id>          seed: run only this seed (repeatable)
  --force              seed: allow seeding when NODE_ENV=production
  --driver <name>      SQLite driver: better-sqlite3 or node:sqlite
  --ssl-ca <path>      PostgreSQL CA certificate file (verify-full unless sslmode is set)
  --lock-timeout <ms>  Wait this long for another runner (default 60000)
  --json               Machine-readable output
  --version            Print the package version
  -h, --help           Show this help

Exit codes: 0 success, 1 failure, 2 usage or configuration error, 3 refused
(checksum mismatch, irreversible migration, lock timeout, production seed guard).`;

class UsageError extends Error {}

interface Output {
  json: boolean;
  secrets: string[];
}

function print(out: Output, data: Record<string, unknown>, text: string): void {
  process.stdout.write(out.json ? `${JSON.stringify(data)}\n` : `${text}\n`);
}

function stderrLogger(out: Output): LoggerLike {
  const write = (level: string) => (obj: Record<string, unknown>, msg?: string) => {
    if (out.json) return;
    if (level === 'debug' || level === 'info') return;
    process.stderr.write(
      `${level}: ${redactText(msg ?? '', out.secrets)} ${redactText(JSON.stringify(obj), out.secrets)}\n`,
    );
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError) return EXIT.usage;
  if (error instanceof DbError) {
    switch (error.code) {
      case DbErrorCode.CONFIG_INVALID:
      case DbErrorCode.MIGRATION_INVALID:
      case DbErrorCode.DRIVER_MISSING:
        return EXIT.usage;
      case DbErrorCode.MIGRATION_CHECKSUM_MISMATCH:
      case DbErrorCode.MIGRATION_IRREVERSIBLE:
      case DbErrorCode.MIGRATION_LOCK_TIMEOUT:
      case DbErrorCode.SEED_REFUSED:
        return EXIT.refused;
      default:
        return EXIT.failure;
    }
  }
  return EXIT.failure;
}

function positiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1)
    throw new UsageError(`--${name} must be a positive integer`);
  return Number(value);
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  const out: Output = { json: argv.includes('--json'), secrets: [] };
  function parse() {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        url: { type: 'string' },
        dir: { type: 'string' },
        seeds: { type: 'string' },
        'table-prefix': { type: 'string' },
        to: { type: 'string' },
        steps: { type: 'string' },
        only: { type: 'string', multiple: true },
        force: { type: 'boolean' },
        driver: { type: 'string' },
        'ssl-ca': { type: 'string' },
        'lock-timeout': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  }
  let db: Database | undefined;
  try {
    try {
      parsed = parse();
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    const { values, positionals } = parsed;
    const command = positionals[0];
    if (values.help || command === undefined || command === 'help') {
      process.stdout.write(`${HELP}\n`);
      return command === undefined && !values.help ? EXIT.usage : EXIT.ok;
    }
    const known = ['migrate', 'status', 'rollback', 'create', 'seed'];
    if (!known.includes(command)) throw new UsageError(`Unknown command: ${command}`);
    const dir = values.dir ?? 'migrations';
    const tablePrefix = values['table-prefix'];
    const lockTimeoutMs = positiveInt(values['lock-timeout'], 'lock-timeout');

    if (command === 'create') {
      const name = positionals.slice(1).join(' ');
      if (!name)
        throw new UsageError(
          'create needs a migration name, for example: aspec-db create add_users',
        );
      const file = await createMigrationFile(dir, name);
      print(out, { ok: true, command, ...file }, `Created ${file.path}`);
      return EXIT.ok;
    }

    const url = values.url ?? process.env.DATABASE_URL;
    if (!url) throw new UsageError('Set DATABASE_URL or pass --url');
    try {
      const password = decodeURIComponent(new URL(url).password);
      if (password) out.secrets.push(password);
    } catch {
      // Not a URL with credentials (SQLite paths); nothing to redact.
    }
    const driver = values.driver;
    if (driver !== undefined && driver !== 'better-sqlite3' && driver !== 'node:sqlite') {
      throw new UsageError('--driver must be better-sqlite3 or node:sqlite');
    }
    const logger = stderrLogger(out);
    const caFile = values['ssl-ca'];
    const sslMode = /[?&]sslmode=([^&]+)/.exec(url)?.[1];
    db = await createDatabase({
      url,
      logger,
      connectRetry: { retries: 2 },
      ...(driver ? { driver: driver as SqliteDriverName } : {}),
      ...(caFile ? { ssl: { caFile, ...(sslMode ? {} : { mode: 'verify-full' as const }) } } : {}),
    });
    const lockOptions = lockTimeoutMs === undefined ? {} : { lockTimeoutMs };
    const prefixOptions = tablePrefix === undefined ? {} : { tablePrefix };

    if (command === 'seed') {
      const seeder = createSeeder(db, {
        directory: values.seeds ?? 'seeds',
        logger,
        ...prefixOptions,
        ...lockOptions,
        ...(values.force ? { force: true } : {}),
      });
      const result = await seeder.run(values.only ? { only: values.only } : {});
      print(
        out,
        { ok: true, command, ...result },
        result.applied.length > 0
          ? `Applied seeds: ${result.applied.join(', ')}`
          : 'No seeds to run',
      );
      return EXIT.ok;
    }

    const migrator = createMigrator(db, {
      directory: dir,
      logger,
      ...prefixOptions,
      ...lockOptions,
    });
    if (command === 'status') {
      const status = await migrator.status();
      const lines = status.map(
        (m) =>
          `${m.state.padEnd(8)} ${m.id}${m.appliedAt ? `  (applied ${new Date(m.appliedAt).toISOString()})` : ''}`,
      );
      const pending = status.filter((m) => m.state === 'pending').length;
      print(
        out,
        { ok: true, command, migrations: status, pending },
        lines.length > 0 ? `${lines.join('\n')}\n${pending} pending` : 'No migrations found',
      );
      return EXIT.ok;
    }
    if (command === 'migrate') {
      const result = await migrator.up(values.to ? { to: values.to } : {});
      print(
        out,
        { ok: true, command, ...result },
        result.migrations.length > 0
          ? `Applied: ${result.migrations.join(', ')}`
          : 'Database is up to date',
      );
      return EXIT.ok;
    }
    const steps = positiveInt(values.steps, 'steps');
    const result = await migrator.down(values.to ? { to: values.to } : { steps: steps ?? 1 });
    print(
      out,
      { ok: true, command, ...result },
      result.migrations.length > 0
        ? `Reverted: ${result.migrations.join(', ')}`
        : 'Nothing to roll back',
    );
    return EXIT.ok;
  } catch (error) {
    const code = exitCodeFor(error);
    const message = redactText(error instanceof Error ? error.message : String(error), out.secrets);
    const errorCodeValue =
      error instanceof DbError ? error.code : error instanceof UsageError ? 'USAGE' : 'ERROR';
    if (out.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: errorCodeValue, message } })}\n`,
      );
    } else {
      process.stderr.write(`aspec-db: ${message}\n`);
      if (error instanceof UsageError) process.stderr.write('Run aspec-db --help for usage.\n');
    }
    return code;
  } finally {
    await db?.close().catch(() => undefined);
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write(`${readVersion()}\n`);
} else {
  main(args).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`aspec-db: ${redactText(String(error))}\n`);
      process.exitCode = EXIT.failure;
    },
  );
}
