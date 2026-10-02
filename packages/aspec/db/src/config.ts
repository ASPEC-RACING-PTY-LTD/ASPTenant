import { fileURLToPath } from 'node:url';
import { DbError, DbErrorCode } from './errors.js';
import type { SqlDialect } from './ports.js';
import { redactUrl } from './redact.js';

export const SSL_MODES = ['disable', 'require', 'verify-ca', 'verify-full'] as const;
export type SslMode = (typeof SSL_MODES)[number];

export const SQLITE_DRIVERS = ['better-sqlite3', 'node:sqlite'] as const;
export type SqliteDriverName = (typeof SQLITE_DRIVERS)[number];

export const JOURNAL_MODES = ['wal', 'delete', 'truncate', 'persist', 'memory', 'off'] as const;
export type JournalMode = (typeof JOURNAL_MODES)[number];

export type PemInput = string | Uint8Array | ReadonlyArray<string | Uint8Array>;

export interface SslConfig {
  mode: SslMode;
  /** CA certificate(s) in PEM form. */
  ca?: PemInput;
  /** Path to a PEM file with CA certificate(s) (`sslrootcert` in URLs). */
  caFile?: string;
  /** Client certificate (PEM) for mutual TLS. */
  cert?: string | Uint8Array;
  certFile?: string;
  /** Client private key (PEM) for mutual TLS. */
  key?: string | Uint8Array;
  keyFile?: string;
  /** Overrides the TLS server name (SNI and hostname verification). */
  servername?: string;
}

export interface PoolConfig {
  /** Maximum connections. Default 10. */
  max: number;
  /** Idle connections are closed after this many milliseconds. Default 10000. 0 disables. */
  idleTimeoutMs: number;
  /** Time to wait for a new connection. Default 10000. 0 waits forever. */
  connectionTimeoutMs: number;
  /** Connections are recycled after this many seconds. Default 0 (never). */
  maxLifetimeSeconds: number;
}

export interface PostgresConfig {
  dialect: 'postgres';
  host: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  ssl: SslConfig;
  pool: PoolConfig;
  /** Server-side statement timeout (`statement_timeout`) in milliseconds. */
  statementTimeoutMs?: number;
  /** Reported in `pg_stat_activity.application_name`. */
  applicationName?: string;
  /** Schemas for `search_path`, for example `['app', 'public']`. */
  searchPath?: string[];
  /** Non-fatal observations, such as ignored URL parameters. */
  warnings: string[];
}

export interface SqliteConfig {
  dialect: 'sqlite';
  /** File path or `:memory:`. */
  filename: string;
  memory: boolean;
  readonly: boolean;
  /** Preferred driver. Default: `better-sqlite3` when installed, otherwise `node:sqlite`. */
  driver?: SqliteDriverName;
  /** Milliseconds SQLite waits on a locked database before `SQLITE_BUSY`. Default 5000. */
  busyTimeoutMs: number;
  /** Journal mode. Default `wal` for files; in-memory databases keep SQLite's default. */
  journalMode?: JournalMode;
  /** Enables `PRAGMA foreign_keys`. Default true. */
  foreignKeys: boolean;
  warnings: string[];
}

export type DatabaseConfig = PostgresConfig | SqliteConfig;

export interface SslConfigInput {
  mode?: SslMode;
  ca?: PemInput;
  caFile?: string;
  cert?: string | Uint8Array;
  certFile?: string;
  key?: string | Uint8Array;
  keyFile?: string;
  servername?: string;
}

/**
 * Serialisable configuration accepted by `validateDatabaseConfig`, `createDatabase` and the
 * driver factories. Explicit fields override values parsed from `url`.
 */
export interface DatabaseConfigInput {
  url?: string;
  dialect?: SqlDialect;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: SslMode | boolean | SslConfigInput;
  pool?: Partial<PoolConfig>;
  statementTimeoutMs?: number;
  applicationName?: string;
  searchPath?: string | readonly string[];
  filename?: string;
  readonly?: boolean;
  driver?: SqliteDriverName;
  busyTimeoutMs?: number;
  journalMode?: JournalMode;
  foreignKeys?: boolean;
}

export const POOL_DEFAULTS: PoolConfig = {
  max: 10,
  idleTimeoutMs: 10_000,
  connectionTimeoutMs: 10_000,
  maxLifetimeSeconds: 0,
};

export const SQLITE_BUSY_TIMEOUT_DEFAULT_MS = 5000;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const DAY_MS = 86_400_000;
const PG_URL_PARAMS = new Set([
  'sslmode',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'application_name',
  'connect_timeout',
  'statement_timeout',
  'host',
  'port',
  'user',
  'password',
  'dbname',
  'options',
]);

interface Draft {
  issues: string[];
  warnings: string[];
}

function configError(issues: readonly string[]): DbError {
  return new DbError(
    DbErrorCode.CONFIG_INVALID,
    `Invalid database configuration: ${issues.join('; ')}`,
    {
      status: 500,
      expose: false,
      details: { issues: [...issues] },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkInt(
  d: Draft,
  name: string,
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    d.issues.push(`${name} must be an integer between ${min} and ${max}`);
    return undefined;
  }
  return value;
}

function checkString(d: Draft, name: string, value: unknown, max = 1024): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    d.issues.push(`${name} must be a non-empty string of at most ${max} characters`);
    return undefined;
  }
  return value;
}

function checkBool(d: Draft, name: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    d.issues.push(`${name} must be a boolean`);
    return undefined;
  }
  return value;
}

function parseIntParam(
  d: Draft,
  name: string,
  raw: string,
  min: number,
  max: number,
): number | undefined {
  if (!/^\d+$/.test(raw)) {
    d.issues.push(`URL parameter ${name} must be a non-negative integer`);
    return undefined;
  }
  return checkInt(d, `URL parameter ${name}`, Number(raw), min, max);
}

/** Classifies a connection string. Windows drive paths and bare paths are SQLite files. */
function dialectOfUrl(url: string): SqlDialect | 'unknown' {
  const lower = url.trim().toLowerCase();
  if (lower.startsWith('postgres://') || lower.startsWith('postgresql://')) return 'postgres';
  if (lower === ':memory:' || lower.startsWith('sqlite:') || lower.startsWith('file:'))
    return 'sqlite';
  if (/^[a-z]:[\\/]/.test(lower)) return 'sqlite';
  if (/^[a-z][a-z0-9+.-]*:/.test(lower)) return 'unknown';
  return 'sqlite';
}

interface PartialPostgres {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: SslConfigInput;
  statementTimeoutMs?: number;
  connectionTimeoutMs?: number;
  applicationName?: string;
  searchPath?: string[];
}

function parsePostgresUrl(d: Draft, raw: string): PartialPostgres {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    d.issues.push(`url is not a valid PostgreSQL connection URL (${redactUrl(raw)})`);
    return {};
  }
  const out: PartialPostgres = {};
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host) out.host = decodeURIComponent(host);
  if (url.port) out.port = Number(url.port);
  if (url.username) out.user = decodeURIComponent(url.username);
  if (url.password) out.password = decodeURIComponent(url.password);
  const db = url.pathname.replace(/^\//, '');
  if (db) out.database = decodeURIComponent(db);
  const ssl: SslConfigInput = {};
  for (const [key, value] of url.searchParams) {
    switch (key) {
      case 'sslmode':
        if ((SSL_MODES as readonly string[]).includes(value)) ssl.mode = value as SslMode;
        else if (value === 'prefer' || value === 'allow') {
          d.issues.push(
            `sslmode=${value} is not supported because the pg driver cannot fall back between TLS and plain connections; use disable, require, verify-ca or verify-full`,
          );
        } else d.issues.push(`sslmode must be one of ${SSL_MODES.join(', ')}`);
        break;
      case 'sslrootcert':
        ssl.caFile = value;
        break;
      case 'sslcert':
        ssl.certFile = value;
        break;
      case 'sslkey':
        ssl.keyFile = value;
        break;
      case 'application_name':
        out.applicationName = value;
        break;
      case 'connect_timeout': {
        const seconds = parseIntParam(d, key, value, 0, 600);
        if (seconds !== undefined) out.connectionTimeoutMs = seconds * 1000;
        break;
      }
      case 'statement_timeout': {
        const ms = parseIntParam(d, key, value, 0, DAY_MS);
        if (ms !== undefined) out.statementTimeoutMs = ms;
        break;
      }
      case 'host':
        out.host = value;
        break;
      case 'port': {
        const port = parseIntParam(d, key, value, 1, 65535);
        if (port !== undefined) out.port = port;
        break;
      }
      case 'user':
        out.user = value;
        break;
      case 'password':
        out.password = value;
        break;
      case 'dbname':
        out.database = value;
        break;
      case 'options': {
        const match = /^-c\s*search_path=([A-Za-z0-9_$,\s]+)$/.exec(value.trim());
        if (match?.[1]) out.searchPath = match[1].split(',').map((s) => s.trim());
        else d.warnings.push('URL parameter options is only honoured for "-c search_path=..."');
        break;
      }
      default:
        if (!PG_URL_PARAMS.has(key))
          d.warnings.push(`URL parameter ${key} is not supported and was ignored`);
    }
  }
  if (Object.keys(ssl).length > 0) out.ssl = ssl;
  return out;
}

interface PartialSqlite {
  filename?: string;
  readonly?: boolean;
  busyTimeoutMs?: number;
  journalMode?: JournalMode;
  driver?: SqliteDriverName;
}

function parseSqliteUrl(d: Draft, raw: string): PartialSqlite {
  let rest = raw.trim();
  let query = '';
  const out: PartialSqlite = {};
  if (/^[a-z]:[\\/]/i.test(rest)) {
    out.filename = rest;
    return out;
  }
  const lower = rest.toLowerCase();
  if (lower.startsWith('sqlite:') || lower.startsWith('file:')) {
    const q = rest.indexOf('?');
    if (q !== -1) {
      query = rest.slice(q + 1);
      rest = rest.slice(0, q);
    }
  }
  if (lower.startsWith('file:')) {
    if (rest.toLowerCase().startsWith('file://')) {
      try {
        out.filename = fileURLToPath(rest);
      } catch {
        d.issues.push(`url is not a valid file URL (${redactUrl(raw)})`);
      }
    } else out.filename = decodeURIComponent(rest.slice('file:'.length));
  } else if (lower.startsWith('sqlite:')) {
    let path = rest.slice('sqlite:'.length);
    if (path.startsWith('//')) {
      path = path.slice(2);
      // sqlite:///C:/data/app.db (Windows absolute) keeps the drive letter.
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    }
    out.filename = decodeURIComponent(path);
  } else {
    out.filename = rest;
  }
  if (out.filename === '' || out.filename === 'memory' || out.filename === ':memory') {
    d.issues.push(
      'url does not contain a SQLite file path; use sqlite::memory: for an in-memory database',
    );
  }
  if (query) {
    for (const [key, value] of new URLSearchParams(query)) {
      switch (key) {
        case 'mode':
          if (value === 'ro') out.readonly = true;
          else if (value === 'rw' || value === 'rwc') out.readonly = false;
          else if (value === 'memory') out.filename = ':memory:';
          else d.issues.push('URL parameter mode must be ro, rw, rwc or memory');
          break;
        case 'busy_timeout': {
          const ms = parseIntParam(d, key, value, 0, 600_000);
          if (ms !== undefined) out.busyTimeoutMs = ms;
          break;
        }
        case 'journal_mode': {
          const mode = value.toLowerCase();
          if ((JOURNAL_MODES as readonly string[]).includes(mode))
            out.journalMode = mode as JournalMode;
          else
            d.issues.push(`URL parameter journal_mode must be one of ${JOURNAL_MODES.join(', ')}`);
          break;
        }
        case 'driver':
          if (value === 'node' || value === 'node:sqlite') out.driver = 'node:sqlite';
          else if (value === 'better-sqlite3') out.driver = 'better-sqlite3';
          else d.issues.push('URL parameter driver must be better-sqlite3 or node:sqlite');
          break;
        default:
          d.warnings.push(`URL parameter ${key} is not supported and was ignored`);
      }
    }
  }
  return out;
}

function normaliseSsl(d: Draft, value: unknown, fromUrl: SslConfigInput | undefined): SslConfig {
  const merged: SslConfigInput = { ...(fromUrl ?? {}) };
  if (value === true) merged.mode = 'verify-full';
  else if (value === false) merged.mode = 'disable';
  else if (typeof value === 'string') {
    if ((SSL_MODES as readonly string[]).includes(value)) merged.mode = value as SslMode;
    else d.issues.push(`ssl must be one of ${SSL_MODES.join(', ')}, a boolean or an object`);
  } else if (isRecord(value)) {
    const v = value as SslConfigInput;
    if (v.mode !== undefined) {
      if ((SSL_MODES as readonly string[]).includes(v.mode)) merged.mode = v.mode;
      else d.issues.push(`ssl.mode must be one of ${SSL_MODES.join(', ')}`);
    }
    if (v.ca !== undefined) merged.ca = v.ca;
    for (const key of ['caFile', 'certFile', 'keyFile', 'servername'] as const) {
      const s = checkString(d, `ssl.${key}`, v[key], 4096);
      if (s !== undefined) merged[key] = s;
    }
    if (v.cert !== undefined) merged.cert = v.cert;
    if (v.key !== undefined) merged.key = v.key;
  } else if (value !== undefined) {
    d.issues.push(`ssl must be one of ${SSL_MODES.join(', ')}, a boolean or an object`);
  }
  const hasMaterial = merged.ca !== undefined || merged.caFile !== undefined;
  const mode: SslMode = merged.mode ?? (hasMaterial ? 'verify-full' : 'disable');
  if (
    mode === 'disable' &&
    (hasMaterial || merged.cert !== undefined || merged.certFile !== undefined)
  ) {
    d.issues.push('ssl certificates were provided but ssl mode is disable');
  }
  if (
    (merged.cert === undefined && merged.certFile === undefined) !==
    (merged.key === undefined && merged.keyFile === undefined)
  ) {
    d.issues.push('ssl client certificate and key must be provided together');
  }
  const out: SslConfig = { mode };
  if (merged.ca !== undefined) out.ca = merged.ca;
  if (merged.caFile !== undefined) out.caFile = merged.caFile;
  if (merged.cert !== undefined) out.cert = merged.cert;
  if (merged.certFile !== undefined) out.certFile = merged.certFile;
  if (merged.key !== undefined) out.key = merged.key;
  if (merged.keyFile !== undefined) out.keyFile = merged.keyFile;
  if (merged.servername !== undefined) out.servername = merged.servername;
  return out;
}

function normaliseSearchPath(d: Draft, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const list =
    typeof value === 'string'
      ? value.split(',').map((s) => s.trim())
      : Array.isArray(value)
        ? (value as unknown[])
        : null;
  if (
    !list ||
    list.length === 0 ||
    !list.every((s) => typeof s === 'string' && IDENTIFIER.test(s))
  ) {
    d.issues.push(
      'searchPath must contain SQL identifiers (letters, digits, _ and $, at most 63 characters)',
    );
    return undefined;
  }
  return list as string[];
}

function buildPostgres(
  d: Draft,
  input: DatabaseConfigInput,
  fromUrl: PartialPostgres,
): PostgresConfig {
  const host = checkString(d, 'host', input.host, 255) ?? fromUrl.host ?? 'localhost';
  const port = checkInt(d, 'port', input.port, 1, 65535) ?? fromUrl.port ?? 5432;
  const poolInput: unknown = input.pool;
  if (poolInput !== undefined && !isRecord(poolInput)) d.issues.push('pool must be an object');
  const p = isRecord(poolInput) ? (poolInput as Partial<PoolConfig>) : {};
  const pool: PoolConfig = {
    max: checkInt(d, 'pool.max', p.max, 1, 1000) ?? POOL_DEFAULTS.max,
    idleTimeoutMs:
      checkInt(d, 'pool.idleTimeoutMs', p.idleTimeoutMs, 0, DAY_MS) ?? POOL_DEFAULTS.idleTimeoutMs,
    connectionTimeoutMs:
      checkInt(d, 'pool.connectionTimeoutMs', p.connectionTimeoutMs, 0, 600_000) ??
      fromUrl.connectionTimeoutMs ??
      POOL_DEFAULTS.connectionTimeoutMs,
    maxLifetimeSeconds:
      checkInt(d, 'pool.maxLifetimeSeconds', p.maxLifetimeSeconds, 0, 7 * 86_400) ??
      POOL_DEFAULTS.maxLifetimeSeconds,
  };
  const out: PostgresConfig = {
    dialect: 'postgres',
    host,
    port,
    ssl: normaliseSsl(d, input.ssl, fromUrl.ssl),
    pool,
    warnings: d.warnings,
  };
  const user = checkString(d, 'user', input.user, 255) ?? fromUrl.user;
  if (user !== undefined) out.user = user;
  if (input.password !== undefined && typeof input.password !== 'string')
    d.issues.push('password must be a string');
  const password = typeof input.password === 'string' ? input.password : fromUrl.password;
  if (password !== undefined) out.password = password;
  const database = checkString(d, 'database', input.database, 255) ?? fromUrl.database;
  if (database !== undefined) out.database = database;
  const statementTimeoutMs =
    checkInt(d, 'statementTimeoutMs', input.statementTimeoutMs, 0, DAY_MS) ??
    fromUrl.statementTimeoutMs;
  if (statementTimeoutMs !== undefined) out.statementTimeoutMs = statementTimeoutMs;
  const applicationName = checkString(
    d,
    'applicationName',
    input.applicationName ?? fromUrl.applicationName,
    63,
  );
  if (applicationName !== undefined) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    if (/[\u0000-\u001f\u007f]/.test(applicationName))
      d.issues.push('applicationName must not contain control characters');
    else out.applicationName = applicationName;
  }
  const searchPath = normaliseSearchPath(d, input.searchPath ?? fromUrl.searchPath);
  if (searchPath !== undefined) out.searchPath = searchPath;
  for (const key of [
    'filename',
    'readonly',
    'driver',
    'busyTimeoutMs',
    'journalMode',
    'foreignKeys',
  ] as const) {
    if (input[key] !== undefined) d.issues.push(`${key} only applies to SQLite`);
  }
  return out;
}

function buildSqlite(d: Draft, input: DatabaseConfigInput, fromUrl: PartialSqlite): SqliteConfig {
  const filename = checkString(d, 'filename', input.filename, 4096) ?? fromUrl.filename;
  if (filename === undefined) d.issues.push('filename (or url) is required for SQLite');
  const resolved = filename ?? ':memory:';
  const memory = resolved === ':memory:' || resolved === '';
  const out: SqliteConfig = {
    dialect: 'sqlite',
    filename: memory ? ':memory:' : resolved,
    memory,
    readonly: checkBool(d, 'readonly', input.readonly) ?? fromUrl.readonly ?? false,
    busyTimeoutMs:
      checkInt(d, 'busyTimeoutMs', input.busyTimeoutMs, 0, 600_000) ??
      fromUrl.busyTimeoutMs ??
      SQLITE_BUSY_TIMEOUT_DEFAULT_MS,
    foreignKeys: checkBool(d, 'foreignKeys', input.foreignKeys) ?? true,
    warnings: d.warnings,
  };
  if (input.driver !== undefined && !(SQLITE_DRIVERS as readonly string[]).includes(input.driver)) {
    d.issues.push(`driver must be one of ${SQLITE_DRIVERS.join(', ')}`);
  }
  const driver = (SQLITE_DRIVERS as readonly string[]).includes(input.driver ?? '')
    ? input.driver
    : fromUrl.driver;
  if (driver !== undefined) out.driver = driver;
  if (
    input.journalMode !== undefined &&
    !(JOURNAL_MODES as readonly string[]).includes(input.journalMode)
  ) {
    d.issues.push(`journalMode must be one of ${JOURNAL_MODES.join(', ')}`);
  }
  const journal = (JOURNAL_MODES as readonly string[]).includes(input.journalMode ?? '')
    ? input.journalMode
    : fromUrl.journalMode;
  if (journal !== undefined) out.journalMode = journal;
  else if (!memory && !out.readonly) out.journalMode = 'wal';
  if (memory && out.readonly) d.issues.push('readonly cannot be used with an in-memory database');
  for (const key of [
    'host',
    'port',
    'user',
    'password',
    'database',
    'ssl',
    'pool',
    'statementTimeoutMs',
    'applicationName',
    'searchPath',
  ] as const) {
    if (input[key] !== undefined) d.issues.push(`${key} only applies to PostgreSQL`);
  }
  return out;
}

/**
 * Validates and normalises database configuration, applying defaults. Throws `DbError`
 * (`DB_CONFIG_INVALID`) listing every problem. Messages never contain passwords.
 */
export function validateDatabaseConfig(input: unknown): DatabaseConfig {
  const d: Draft = { issues: [], warnings: [] };
  if (typeof input === 'string') return validateDatabaseConfig({ url: input });
  if (!isRecord(input)) throw configError(['configuration must be an object or a connection URL']);
  const cfg = input as DatabaseConfigInput;
  if (cfg.dialect !== undefined && cfg.dialect !== 'postgres' && cfg.dialect !== 'sqlite') {
    throw configError(['dialect must be postgres or sqlite']);
  }
  let dialect: SqlDialect | undefined = cfg.dialect;
  let fromPg: PartialPostgres = {};
  let fromSqlite: PartialSqlite = {};
  if (cfg.url !== undefined) {
    if (typeof cfg.url !== 'string' || cfg.url.trim() === '')
      throw configError(['url must be a non-empty string']);
    const detected = dialectOfUrl(cfg.url);
    if (detected === 'unknown') {
      const scheme = cfg.url.slice(0, cfg.url.indexOf(':') + 1).toLowerCase();
      throw configError([
        `url protocol ${scheme} is not supported; use postgres://, postgresql://, sqlite:, file: or a file path`,
      ]);
    }
    if (dialect !== undefined && dialect !== detected) {
      throw configError([`dialect ${dialect} does not match the ${detected} url`]);
    }
    dialect = detected;
    if (detected === 'postgres') fromPg = parsePostgresUrl(d, cfg.url);
    else fromSqlite = parseSqliteUrl(d, cfg.url);
  }
  if (dialect === undefined) {
    if (cfg.filename !== undefined) dialect = 'sqlite';
    else if (cfg.host !== undefined) dialect = 'postgres';
    else throw configError(['url, filename or host is required']);
  }
  const config =
    dialect === 'postgres' ? buildPostgres(d, cfg, fromPg) : buildSqlite(d, cfg, fromSqlite);
  if (d.issues.length > 0) throw configError(d.issues);
  return config;
}

/** Parses a connection URL (postgres, postgresql, sqlite, file or a file path) into configuration. */
export function parseDatabaseUrl(url: string): DatabaseConfig {
  return validateDatabaseConfig({ url });
}

/** Returns a loggable description of a configuration with the password removed. */
export function describeDatabaseConfig(config: DatabaseConfig): Record<string, unknown> {
  if (config.dialect === 'sqlite') {
    return {
      dialect: 'sqlite',
      filename: config.filename,
      readonly: config.readonly,
      driver: config.driver,
    };
  }
  return {
    dialect: 'postgres',
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    ssl: config.ssl.mode,
    poolMax: config.pool.max,
    password: config.password === undefined ? undefined : '***',
  };
}
