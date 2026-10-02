import { describe, expect, it } from 'vitest';
import { describeDatabaseConfig, parseDatabaseUrl, validateDatabaseConfig } from '../src/config.js';
import { buildPgPoolConfig, buildPgSslOptions } from '../src/drivers/postgres.js';
import { DbError } from '../src/errors.js';
import { redactText, redactUrl } from '../src/redact.js';

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('DB_CONFIG_INVALID');
    return ((error as DbError).details as { issues: string[] }).issues;
  }
  throw new Error('expected a configuration error');
}

describe('parseDatabaseUrl', () => {
  it('parses postgres and postgresql URLs with defaults', () => {
    for (const scheme of ['postgres', 'postgresql']) {
      const config = parseDatabaseUrl(
        `${scheme}://app:s%40cret@db.example.com:6543/main?sslmode=verify-full&application_name=api`,
      );
      expect(config).toMatchObject({
        dialect: 'postgres',
        host: 'db.example.com',
        port: 6543,
        user: 'app',
        password: 's@cret',
        database: 'main',
        applicationName: 'api',
        ssl: { mode: 'verify-full' },
        pool: { max: 10, idleTimeoutMs: 10_000, connectionTimeoutMs: 10_000 },
      });
    }
  });

  it('maps libpq parameters', () => {
    const config = parseDatabaseUrl(
      'postgres://u@h/db?connect_timeout=3&statement_timeout=2500&sslmode=require&options=-c%20search_path%3Dapp,public',
    );
    expect(config).toMatchObject({
      pool: { connectionTimeoutMs: 3000 },
      statementTimeoutMs: 2500,
      ssl: { mode: 'require' },
      searchPath: ['app', 'public'],
    });
  });

  it('warns about unsupported parameters instead of failing', () => {
    const config = parseDatabaseUrl('postgres://u@h/db?schema=public');
    expect(config.warnings).toEqual(['URL parameter schema is not supported and was ignored']);
  });

  it('rejects sslmode values the pg driver cannot honour', () => {
    expect(issuesOf(() => parseDatabaseUrl('postgres://u@h/db?sslmode=prefer'))[0]).toMatch(
      /not supported/,
    );
    expect(issuesOf(() => parseDatabaseUrl('postgres://u@h/db?sslmode=bogus'))[0]).toMatch(
      /sslmode must be/,
    );
  });

  it('parses SQLite URLs and file paths', () => {
    expect(parseDatabaseUrl('sqlite::memory:')).toMatchObject({
      dialect: 'sqlite',
      filename: ':memory:',
      memory: true,
    });
    expect(parseDatabaseUrl(':memory:')).toMatchObject({ memory: true });
    expect(parseDatabaseUrl('sqlite:data/app.db')).toMatchObject({
      filename: 'data/app.db',
      journalMode: 'wal',
    });
    expect(parseDatabaseUrl('sqlite://data/app.db')).toMatchObject({ filename: 'data/app.db' });
    expect(parseDatabaseUrl('sqlite:///var/lib/app.db')).toMatchObject({
      filename: '/var/lib/app.db',
    });
    expect(parseDatabaseUrl('sqlite:///C:/data/app.db')).toMatchObject({
      filename: 'C:/data/app.db',
    });
    expect(parseDatabaseUrl('C:\\data\\app.db')).toMatchObject({
      dialect: 'sqlite',
      filename: 'C:\\data\\app.db',
    });
    expect(parseDatabaseUrl('./local.sqlite')).toMatchObject({
      dialect: 'sqlite',
      filename: './local.sqlite',
    });
    expect(parseDatabaseUrl('file:app.db?mode=ro&busy_timeout=250')).toMatchObject({
      filename: 'app.db',
      readonly: true,
      busyTimeoutMs: 250,
    });
    expect(parseDatabaseUrl('sqlite:app.db?driver=node&journal_mode=delete')).toMatchObject({
      driver: 'node:sqlite',
      journalMode: 'delete',
    });
  });

  it('rejects unsupported protocols without echoing credentials', () => {
    const issues = issuesOf(() => parseDatabaseUrl('mysql://root:hunter22@localhost/app'));
    expect(issues[0]).toMatch(/mysql: is not supported/);
    expect(issues.join(' ')).not.toContain('hunter22');
  });
});

describe('validateDatabaseConfig', () => {
  it('validates pool limits and names every invalid option', () => {
    const issues = issuesOf(() =>
      validateDatabaseConfig({
        url: 'postgres://u:topsecret@h/db',
        pool: { max: 0, idleTimeoutMs: -1, connectionTimeoutMs: 1.5 },
        statementTimeoutMs: 'soon',
        searchPath: ['ok', 'bad name'],
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('pool.max'),
        expect.stringContaining('pool.idleTimeoutMs'),
        expect.stringContaining('pool.connectionTimeoutMs'),
        expect.stringContaining('statementTimeoutMs'),
        expect.stringContaining('searchPath'),
      ]),
    );
  });

  it('never includes the password in error messages', () => {
    try {
      validateDatabaseConfig({ url: 'postgres://u:topsecret@h/db', pool: { max: 5000 } });
      throw new Error('expected failure');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('topsecret');
      expect(JSON.stringify((error as DbError).details)).not.toContain('topsecret');
    }
  });

  it('rejects options for the other dialect and mismatched dialects', () => {
    expect(
      issuesOf(() => validateDatabaseConfig({ filename: 'a.db', pool: { max: 2 } }))[0],
    ).toMatch(/only applies to PostgreSQL/);
    expect(
      issuesOf(() => validateDatabaseConfig({ url: 'postgres://h/db', busyTimeoutMs: 5 }))[0],
    ).toMatch(/only applies to SQLite/);
    expect(
      issuesOf(() => validateDatabaseConfig({ dialect: 'sqlite', url: 'postgres://h/db' }))[0],
    ).toMatch(/does not match/);
    expect(issuesOf(() => validateDatabaseConfig({}))[0]).toMatch(/required/);
    expect(
      issuesOf(() => validateDatabaseConfig({ filename: ':memory:', readonly: true }))[0],
    ).toMatch(/in-memory/);
  });

  it('validates SSL settings', () => {
    expect(validateDatabaseConfig({ host: 'h', ssl: true })).toMatchObject({
      ssl: { mode: 'verify-full' },
    });
    expect(validateDatabaseConfig({ host: 'h', ssl: { ca: 'PEM' } })).toMatchObject({
      ssl: { mode: 'verify-full', ca: 'PEM' },
    });
    expect(
      issuesOf(() => validateDatabaseConfig({ host: 'h', ssl: { mode: 'disable', ca: 'PEM' } }))[0],
    ).toMatch(/disable/);
    expect(
      issuesOf(() => validateDatabaseConfig({ host: 'h', ssl: { mode: 'require', cert: 'C' } }))[0],
    ).toMatch(/together/);
  });

  it('describes configuration without the password', () => {
    const described = describeDatabaseConfig(parseDatabaseUrl('postgres://u:pw1234@h/db'));
    expect(described.password).toBe('***');
    expect(JSON.stringify(described)).not.toContain('pw1234');
  });
});

describe('pg configuration mapping', () => {
  it('maps SSL modes to TLS options', () => {
    expect(buildPgSslOptions({ mode: 'disable' })).toBe(false);
    expect(buildPgSslOptions({ mode: 'require' })).toEqual({ rejectUnauthorized: false });
    const verifyCa = buildPgSslOptions({ mode: 'verify-ca', ca: 'CA-PEM' });
    expect(verifyCa).toMatchObject({ rejectUnauthorized: true, ca: ['CA-PEM'] });
    expect(verifyCa && typeof verifyCa.checkServerIdentity).toBe('function');
    const full = buildPgSslOptions({
      mode: 'verify-full',
      ca: ['A', 'B'],
      servername: 'db.internal',
    });
    expect(full).toEqual({ rejectUnauthorized: true, ca: ['A', 'B'], servername: 'db.internal' });
  });

  it('reports unreadable certificate files without leaking content', () => {
    expect(() =>
      buildPgSslOptions({ mode: 'verify-full', caFile: 'Z:/does/not/exist.pem' }),
    ).toThrow(/Cannot read SSL CA file/);
  });

  it('builds pg.Pool options', () => {
    const pool = buildPgPoolConfig(
      validateDatabaseConfig({
        url: 'postgres://u:p@h:1/db',
        pool: { max: 3, idleTimeoutMs: 1, connectionTimeoutMs: 2, maxLifetimeSeconds: 60 },
        statementTimeoutMs: 1000,
        applicationName: 'svc',
        searchPath: 'app, public',
      }) as never,
    );
    expect(pool).toMatchObject({
      host: 'h',
      port: 1,
      user: 'u',
      password: 'p',
      database: 'db',
      max: 3,
      idleTimeoutMillis: 1,
      connectionTimeoutMillis: 2,
      maxLifetimeSeconds: 60,
      statement_timeout: 1000,
      application_name: 'svc',
      options: '-c search_path=app,public',
      ssl: false,
    });
  });
});

describe('redaction', () => {
  it('redacts URL passwords and password parameters', () => {
    expect(redactUrl('postgres://user:pa:ss@host/db')).toBe('postgres://user:***@host/db');
    expect(redactUrl('postgres://host/db?password=abc&x=1')).toBe(
      'postgres://host/db?password=***&x=1',
    );
    expect(redactUrl('postgres://user@host/db')).toBe('postgres://user@host/db');
  });

  it('redacts known secrets in free text', () => {
    expect(redactText('auth failed with hunter2 for x', ['hunter2'])).toBe(
      'auth failed with *** for x',
    );
    expect(redactText('short a stays', ['a'])).toBe('short a stays');
  });
});
