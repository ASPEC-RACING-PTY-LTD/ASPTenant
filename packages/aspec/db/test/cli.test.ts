import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const dirs: Array<{ cleanup(): void }> = [];

beforeAll(() => {
  const build = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
    cwd: root,
    encoding: 'utf8',
    shell: true,
  });
  if (build.status !== 0) {
    throw new Error(`Failed to build CLI for tests:\n${build.stdout}\n${build.stderr}`);
  }
});

afterEach(() => {
  while (dirs.length > 0) dirs.pop()?.cleanup();
});

function run(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('aspec-db CLI', () => {
  it('prints help and version', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('aspec-db');
    const version = run(['--version']);
    expect(version.status ?? 0).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('migrates, statuses, seeds and rolls back a SQLite database', () => {
    const dir = tempDir();
    dirs.push(dir);
    const migrations = join(dir.path, 'migrations');
    const seeds = join(dir.path, 'seeds');
    mkdirSync(migrations, { recursive: true });
    mkdirSync(seeds, { recursive: true });
    writeFileSync(
      join(migrations, '0001_init.sql'),
      '-- migrate:up\nCREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);\n-- migrate:down\nDROP TABLE t;\n',
    );
    writeFileSync(join(seeds, '01_row.sql'), "INSERT INTO t (id, name) VALUES (1, 'cli');\n");
    const url = join(dir.path, 'app.db');

    const migrate = run([
      'migrate',
      '--url',
      url,
      '--dir',
      migrations,
      '--driver',
      'better-sqlite3',
      '--json',
    ]);
    expect(migrate.status, migrate.stderr || migrate.stdout).toBe(0);
    expect(JSON.parse(migrate.stdout).migrations).toContain('0001_init');

    const status = run([
      'status',
      '--url',
      url,
      '--dir',
      migrations,
      '--driver',
      'better-sqlite3',
      '--json',
    ]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).pending).toBe(0);

    const seed = run([
      'seed',
      '--url',
      url,
      '--seeds',
      seeds,
      '--driver',
      'better-sqlite3',
      '--json',
    ]);
    expect(seed.status).toBe(0);
    expect(JSON.parse(seed.stdout).applied).toContain('01_row');

    writeFileSync(join(seeds, '02_more.sql'), "INSERT INTO t (id, name) VALUES (2, 'prod');\n");
    const refusedPending = run(
      ['seed', '--url', url, '--seeds', seeds, '--driver', 'better-sqlite3', '--json'],
      { NODE_ENV: 'production' },
    );
    expect(refusedPending.status).toBe(3);
    expect(JSON.parse(refusedPending.stdout).ok).toBe(false);

    const rollback = run([
      'rollback',
      '--url',
      url,
      '--dir',
      migrations,
      '--driver',
      'better-sqlite3',
      '--json',
    ]);
    expect(rollback.status).toBe(0);
    expect(JSON.parse(rollback.stdout).migrations).toContain('0001_init');

    const create = run(['create', 'add_notes', '--dir', migrations]);
    expect(create.status).toBe(0);
    expect(create.stdout).toMatch(/Created /);
  });

  it('exits 2 when DATABASE_URL is missing', () => {
    const result = run(['status'], { DATABASE_URL: '' });
    expect(result.status).toBe(2);
  });
});
