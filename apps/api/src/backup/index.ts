import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { SqlClient } from '@aspec/db';
import { ConflictError, UnprocessableError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { ALL_TENANTS_SCOPE, PLATFORM_SCOPE, tenancyBackfillSql } from '../directory/index.js';
import { type Job, JobStore } from '../jobs/store.js';
import { SettingsStore } from '../mail/store.js';
import type { Platform } from '../platform.js';
import { SecretBox } from '../secrets.js';
import { bindTenant, scopedClient } from '../tenancy.js';

export const BACKUP_KIND = 'backup';
const KEY = 'backup';
const MAGIC = Buffer.from('ATBK1');
const PAGE = 200;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      password,
      salt,
      32,
      { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export interface BackupTarget {
  put(key: string, file: string): Promise<void>;
  get(key: string, file: string): Promise<void>;
  list(): Promise<{ key: string; size: number; modifiedAt: number }[]>;
  remove(key: string): Promise<void>;
  test(): Promise<void>;
}

export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export function s3Target(settings: S3Settings): BackupTarget {
  const client = new S3Client({
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
    region: settings.region || 'auto',
    forcePathStyle: settings.forcePathStyle,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  });
  const full = (key: string) => `${settings.prefix}${key}`;
  return {
    async put(key, file) {
      await new Upload({
        client,
        params: { Bucket: settings.bucket, Key: full(key), Body: createReadStream(file) },
        partSize: 16 * 1024 * 1024,
        queueSize: 2,
      }).done();
    },
    async get(key, file) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: settings.bucket, Key: full(key) }),
      );
      if (!result.Body) throw new Error('Empty object');
      await pipeline(result.Body as Readable, createWriteStream(file));
    },
    async list() {
      const out: { key: string; size: number; modifiedAt: number }[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: settings.bucket,
            Prefix: settings.prefix,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
        for (const item of page.Contents ?? []) {
          if (!item.Key?.endsWith('.atbk')) continue;
          out.push({
            key: item.Key.slice(settings.prefix.length),
            size: item.Size ?? 0,
            modifiedAt: item.LastModified?.getTime() ?? 0,
          });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out.sort((a, b) => a.key.localeCompare(b.key));
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: full(key) }));
    },
    async test() {
      const key = full(`.aspectenant-test-${randomUUID()}`);
      await client.send(new PutObjectCommand({ Bucket: settings.bucket, Key: key, Body: 'ok' }));
      await client.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: key }));
      await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: key }));
    },
  };
}

/** Directory target, used by tests. */
export function directoryTarget(dir: string): BackupTarget {
  return {
    async put(key, file) {
      await mkdir(dir, { recursive: true });
      await copyFile(file, join(dir, key));
    },
    async get(key, file) {
      await copyFile(join(dir, key), file);
    },
    async list() {
      await mkdir(dir, { recursive: true });
      const names = (await readdir(dir)).filter((name) => name.endsWith('.atbk')).sort();
      return Promise.all(
        names.map(async (name) => {
          const info = await stat(join(dir, name));
          return { key: name, size: info.size, modifiedAt: info.mtimeMs };
        }),
      );
    },
    async remove(key) {
      await rm(join(dir, key), { force: true });
    },
    async test() {
      await mkdir(dir, { recursive: true });
    },
  };
}

interface StoredBackupSettings {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string | null;
  forcePathStyle: boolean;
  passphrase: string | null;
  intervalHours: number;
  retentionCount: number;
}

export interface BackupSettingsView
  extends Omit<StoredBackupSettings, 'secretAccessKey' | 'passphrase'> {
  hasSecret: boolean;
  hasPassphrase: boolean;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
}

const DEFAULTS: StoredBackupSettings = {
  enabled: false,
  endpoint: '',
  region: 'auto',
  bucket: '',
  prefix: 'aspectenant/',
  accessKeyId: '',
  secretAccessKey: null,
  forcePathStyle: false,
  passphrase: null,
  intervalHours: 24,
  retentionCount: 14,
};

interface BackupData {
  key: string | null;
  trigger: 'manual' | 'scheduled' | 'restore';
  sourceKey?: string;
}

interface BackupProgress {
  tables: number;
  rows: number;
  bytes: number;
}

type Encoded = unknown;

function encodeValue(value: unknown): Encoded {
  if (value instanceof Uint8Array) return { $b: Buffer.from(value).toString('base64') };
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function decodeValue(value: Encoded): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.$b === 'string' && Object.keys(record).length === 1)
      return Buffer.from(record.$b, 'base64');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return JSON.stringify(value);
  return value;
}

function reencrypt(value: unknown, from: SecretBox, to: SecretBox): unknown {
  if (typeof value === 'string' && value.startsWith('v1.')) {
    try {
      return to.encrypt(from.decrypt(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => reencrypt(item, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, reencrypt(v, from, to)]),
    );
  }
  return value;
}

export class BackupService {
  readonly jobs: JobStore;
  private readonly platform: Platform;
  private readonly settings: SettingsStore;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** Overrides the S3 target (tests). */
  targetOverride: BackupTarget | null = null;
  /** Restart after a restore so caches reload. Disabled in tests. */
  exitAfterRestore = true;

  /** Backups cover the whole installation, so this client sees every tenant's rows. */
  private readonly db: SqlClient;

  constructor(platform: Platform) {
    this.platform = platform;
    this.db = scopedClient(platform, ALL_TENANTS_SCOPE);
    this.jobs = new JobStore(this.db, () => PLATFORM_SCOPE);
    this.settings = new SettingsStore(this.db);
  }

  /** Backup settings and history belong to the installation, not to a tenant. */
  private async tenantId(): Promise<string> {
    return PLATFORM_SCOPE;
  }

  private async load(): Promise<StoredBackupSettings> {
    return {
      ...DEFAULTS,
      ...((await this.settings.get<StoredBackupSettings>(await this.tenantId(), KEY)) ?? {}),
    };
  }

  private staging(): string {
    return join(this.platform.config.dataDir, 'backups');
  }

  async view(): Promise<BackupSettingsView> {
    const stored = await this.load();
    const last = (await this.jobs.list<BackupData, BackupProgress>(BACKUP_KIND, 100)).find(
      (job) => job.status === 'succeeded' && job.data.trigger !== 'restore',
    );
    const lastSuccessAt = last?.finishedAt ?? null;
    const { secretAccessKey, passphrase, ...rest } = stored;
    return {
      ...rest,
      hasSecret: Boolean(secretAccessKey),
      hasPassphrase: Boolean(passphrase),
      lastSuccessAt,
      nextRunAt: stored.enabled ? (lastSuccessAt ?? 0) + stored.intervalHours * 3_600_000 : null,
    };
  }

  async update(
    input: Partial<Omit<StoredBackupSettings, 'secretAccessKey' | 'passphrase'>> & {
      secretAccessKey?: string;
      passphrase?: string;
    },
    actor: Actor,
  ): Promise<BackupSettingsView> {
    const stored = await this.load();
    const next: StoredBackupSettings = { ...stored };
    for (const key of [
      'enabled',
      'endpoint',
      'region',
      'bucket',
      'prefix',
      'accessKeyId',
      'forcePathStyle',
      'intervalHours',
      'retentionCount',
    ] as const) {
      if (input[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = input[key];
    }
    if (next.prefix && !next.prefix.endsWith('/')) next.prefix += '/';
    if (input.secretAccessKey)
      next.secretAccessKey = this.platform.secrets.encrypt(input.secretAccessKey);
    if (input.passphrase) {
      if (input.passphrase.length < 12)
        throw new UnprocessableError('Use an encryption passphrase of at least 12 characters.');
      next.passphrase = this.platform.secrets.encrypt(input.passphrase);
    }
    if (
      next.enabled &&
      (!next.bucket || !next.accessKeyId || !next.secretAccessKey || !next.passphrase)
    ) {
      throw new UnprocessableError(
        'Bucket, access key, secret and encryption passphrase are required.',
      );
    }
    next.intervalHours = Math.min(Math.max(Math.round(next.intervalHours), 1), 24 * 30);
    next.retentionCount = Math.min(Math.max(Math.round(next.retentionCount), 1), 1000);
    await this.settings.set(await this.tenantId(), KEY, next);
    await this.platform.audit.record({
      action: 'backup.settings.updated',
      outcome: 'success',
      category: 'admin',
      actor,
      resource: { type: 'backup', id: KEY },
      changes: { after: { enabled: next.enabled, bucket: next.bucket, endpoint: next.endpoint } },
    });
    return this.view();
  }

  private async target(stored?: StoredBackupSettings): Promise<BackupTarget> {
    if (this.targetOverride) return this.targetOverride;
    const settings = stored ?? (await this.load());
    if (!settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) {
      throw new UnprocessableError('Configure the bucket and credentials first.');
    }
    return s3Target({
      ...settings,
      secretAccessKey: this.platform.secrets.decrypt(settings.secretAccessKey),
    });
  }

  async test(): Promise<{ detail: string }> {
    try {
      const target = await this.target();
      await target.test();
      const items = await target.list();
      return { detail: `Connected. ${items.length} backups found in the bucket.` };
    } catch (error) {
      if (error instanceof UnprocessableError) throw error;
      throw new UnprocessableError(
        `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async listRemote() {
    return (await this.target()).list();
  }

  history() {
    return this.jobs.list<BackupData, BackupProgress>(BACKUP_KIND, 50);
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 5 * 60 * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const view = await this.view().catch(() => null);
    if (!view?.enabled || this.busy || !view.nextRunAt || Date.now() < view.nextRunAt) return;
    await this.run('scheduled', null).catch((error: unknown) => {
      this.platform.logger.error({ err: error }, 'scheduled backup failed');
    });
  }

  /** Creates an encrypted logical dump of every table and uploads it. */
  async run(
    trigger: 'manual' | 'scheduled',
    actor: Actor | null,
  ): Promise<Job<BackupData, BackupProgress>> {
    if (this.busy) throw new ConflictError('A backup or restore is already running.');
    const stored = await this.load();
    if (!stored.passphrase) throw new UnprocessableError('Set an encryption passphrase first.');
    const target = await this.target(stored);
    this.busy = true;
    const job = await this.jobs.create<BackupData, BackupProgress>({
      tenantId: await this.tenantId(),
      kind: BACKUP_KIND,
      status: 'running',
      title: trigger === 'manual' ? 'Manual backup' : 'Scheduled backup',
      data: { key: null, trigger },
      progress: { tables: 0, rows: 0, bytes: 0 },
      createdBy: actor?.id ?? null,
    });
    const file = join(this.staging(), `${job.id}.atbk`);
    try {
      await mkdir(this.staging(), { recursive: true });
      const progress = await this.dump(file, this.platform.secrets.decrypt(stored.passphrase));
      const key = `aspectenant-${new Date().toISOString().replace(/[:.]/g, '-')}.atbk`;
      await target.put(key, file);
      progress.bytes = (await stat(file)).size;
      await this.jobs.update(job.id, { status: 'succeeded', data: { key, trigger }, progress });
      await this.prune(target, stored.retentionCount);
      if (actor) {
        await this.platform.audit.record({
          action: 'backup.created',
          outcome: 'success',
          category: 'admin',
          actor,
          resource: { type: 'backup', id: key },
        });
      }
    } catch (error) {
      await this.jobs.update(job.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.busy = false;
      await rm(file, { force: true });
    }
    return (await this.jobs.get<BackupData, BackupProgress>(job.id)) ?? job;
  }

  private async prune(target: BackupTarget, keep: number): Promise<void> {
    const items = await target.list();
    for (const item of items.slice(0, Math.max(0, items.length - keep)))
      await target.remove(item.key);
  }

  private async tables(): Promise<string[]> {
    const db = this.db;
    const result =
      db.dialect === 'postgres'
        ? await db.query(
            `SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()`,
          )
        : await db.query(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          );
    return result.rows
      .map((row) => String(row.name))
      .filter((name) => !/_migrations$/.test(name))
      .sort();
  }

  private async dump(file: string, passphrase: string): Promise<BackupProgress> {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await scrypt(passphrase, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const out = createWriteStream(file);
    out.write(Buffer.concat([MAGIC, salt, iv]));
    const gzip = createGzip();
    const progress: BackupProgress = { tables: 0, rows: 0, bytes: 0 };
    const db = this.db;
    const tables = await this.tables();
    const lines = async function* (this: BackupService) {
      yield `${JSON.stringify({
        type: 'manifest',
        product: 'ASPECTenant',
        version: this.platform.config.appVersion,
        createdAt: Date.now(),
        dialect: db.dialect,
        secretKey: this.platform.secrets.exportKey(),
        tables,
      })}\n`;
      for (const table of tables) {
        progress.tables += 1;
        yield `${JSON.stringify({ type: 'table', name: table })}\n`;
        for (let offset = 0; ; offset += PAGE) {
          const page = await db.query(
            `SELECT * FROM "${table}" ORDER BY 1 LIMIT ${PAGE} OFFSET ${offset}`,
          );
          for (const row of page.rows) {
            progress.rows += 1;
            const encoded: Record<string, unknown> = {};
            for (const [column, value] of Object.entries(row)) encoded[column] = encodeValue(value);
            yield `${JSON.stringify({ type: 'row', t: table, r: encoded })}\n`;
          }
          if (page.rows.length < PAGE) break;
        }
      }
    }.call(this);
    await pipeline(Readable.from(lines), gzip, cipher, out, { end: false });
    await new Promise<void>((resolve, reject) => {
      out.end(cipher.getAuthTag(), () => resolve());
      out.on('error', reject);
    });
    return progress;
  }

  /** Decrypts and verifies a backup file into a gzip stream file. Throws on a wrong passphrase. */
  private async decrypt(file: string, plainFile: string, passphrase: string): Promise<void> {
    const size = (await stat(file)).size;
    const handle = await open(file, 'r');
    const header = Buffer.alloc(33);
    const tag = Buffer.alloc(16);
    await handle.read(header, 0, 33, 0);
    await handle.read(tag, 0, 16, size - 16);
    await handle.close();
    if (!header.subarray(0, 5).equals(MAGIC))
      throw new UnprocessableError('Not an ASPECTenant backup.');
    const key = await scrypt(passphrase, header.subarray(5, 21));
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(21, 33));
    decipher.setAuthTag(tag);
    try {
      await pipeline(
        createReadStream(file, { start: 33, end: size - 17 }),
        decipher,
        createWriteStream(plainFile),
      );
    } catch {
      throw new UnprocessableError('The passphrase is wrong or the backup is damaged.');
    }
  }

  /** Restores a backup from the bucket, replacing all current data. */
  async restore(
    key: string,
    options: { passphrase?: string; target?: BackupTarget; actor?: Actor | null } = {},
  ): Promise<{ tables: number; rows: number }> {
    if (this.busy) throw new ConflictError('A backup or restore is already running.');
    const stored = await this.load();
    const passphrase =
      options.passphrase ??
      (stored.passphrase ? this.platform.secrets.decrypt(stored.passphrase) : null);
    if (!passphrase) throw new UnprocessableError('Enter the backup encryption passphrase.');
    const target = options.target ?? (await this.target(stored));
    this.busy = true;
    await mkdir(this.staging(), { recursive: true });
    const id = randomUUID();
    const file = join(this.staging(), `restore-${id}.atbk`);
    const plain = join(this.staging(), `restore-${id}.gz`);
    try {
      await target.get(key, file);
      await this.decrypt(file, plain, passphrase);
      const result = await this.apply(plain);
      this.platform.logger.warn({ key, ...result }, 'backup restored');
      if (this.exitAfterRestore) setTimeout(() => process.exit(0), 1500).unref();
      return result;
    } finally {
      this.busy = false;
      await rm(file, { force: true });
      await rm(plain, { force: true });
    }
  }

  private async columns(table: string): Promise<Set<string>> {
    const db = this.db;
    const result =
      db.dialect === 'postgres'
        ? await db.query(
            `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
            [table],
          )
        : await db.query(`SELECT name FROM pragma_table_info('${table.replace(/'/g, "''")}')`);
    return new Set(result.rows.map((row) => String(row.name)));
  }

  private async apply(plainFile: string): Promise<{ tables: number; rows: number }> {
    const db = this.platform.db;
    const local = new Set(await this.tables());
    let source: SecretBox | null = null;
    let tables = 0;
    let rows = 0;
    let current: { name: string; columns: Set<string> } | null = null;
    await db.transaction(async () => {
      // A restore replaces every tenant's data, so it runs with the all-tenants binding.
      await bindTenant(db, ALL_TENANTS_SCOPE);
      const restoreForeignKeys = db.dialect === 'postgres' ? await this.suspendForeignKeys() : null;
      if (db.dialect !== 'postgres') await db.query(`PRAGMA defer_foreign_keys = ON`);
      // Open the file only now: lines emitted before iteration starts would be lost and the
      // loop would wait for them forever.
      const reader = createInterface({
        input: createReadStream(plainFile).pipe(createGunzip()),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      for await (const line of reader) {
        if (!line) continue;
        const entry = JSON.parse(line) as {
          type: string;
          name?: string;
          t?: string;
          r?: Record<string, unknown>;
          secretKey?: string;
          product?: string;
          tables?: string[];
        };
        if (entry.type === 'manifest') {
          if (entry.product !== 'ASPECTenant')
            throw new UnprocessableError('Not an ASPECTenant backup.');
          source = entry.secretKey ? SecretBox.fromExported(entry.secretKey) : null;
          for (const table of entry.tables ?? []) {
            if (local.has(table) && !isLedger(table)) await db.query(`DELETE FROM "${table}"`);
          }
        } else if (entry.type === 'table' && entry.name) {
          // The local migration ledger describes the local schema; never replace it.
          current =
            local.has(entry.name) && !isLedger(entry.name)
              ? { name: entry.name, columns: await this.columns(entry.name) }
              : null;
          if (current) tables += 1;
        } else if (entry.type === 'row' && current && entry.r) {
          const record = entry.r;
          const names = Object.keys(record).filter((column) => current?.columns.has(column));
          const values = names.map((column) => {
            let value = decodeValue(record[column]);
            if (
              source &&
              current?.name === 'aspectenant_settings' &&
              column === 'value' &&
              typeof value === 'string'
            ) {
              value = JSON.stringify(reencrypt(JSON.parse(value), source, this.platform.secrets));
            }
            return value;
          });
          await db.query(
            `INSERT INTO "${current.name}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names
              .map((_, i) => `$${i + 1}`)
              .join(', ')})`,
            values,
          );
          rows += 1;
        }
      }
      // Backups from single-tenant releases have no tenant columns on some rows.
      for (const sql of tenancyBackfillSql()) await db.query(sql);
      if (restoreForeignKeys) await restoreForeignKeys();
    });
    return { tables, rows };
  }

  /**
   * Drops foreign keys for the duration of a restore so rows can arrive in any order, and
   * returns a function that adds them back (PostgreSQL validates them again then). The
   * application role owns its tables, so it may do this without superuser rights.
   */
  private async suspendForeignKeys(): Promise<() => Promise<void>> {
    const db = this.platform.db;
    const result = await db.query<{ table_name: string; name: string; definition: string }>(
      `SELECT rel.relname AS table_name, con.conname AS name,
              pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE con.contype = 'f' AND nsp.nspname = current_schema()`,
    );
    for (const row of result.rows) {
      await db.query(`ALTER TABLE "${row.table_name}" DROP CONSTRAINT "${row.name}"`);
    }
    return async () => {
      for (const row of result.rows) {
        await db.query(
          `ALTER TABLE "${row.table_name}" ADD CONSTRAINT "${row.name}" ${row.definition}`,
        );
      }
    };
  }

  /** Records a restore in history (after the restore so it survives the data replacement). */
  async recordRestore(
    key: string,
    result: { tables: number; rows: number },
    actor: Actor | null,
  ): Promise<void> {
    const job = await this.jobs.create<BackupData, BackupProgress>({
      tenantId: await this.tenantId(),
      kind: BACKUP_KIND,
      status: 'succeeded',
      title: `Restored ${key}`,
      data: { key, trigger: 'restore', sourceKey: key },
      progress: { tables: result.tables, rows: result.rows, bytes: 0 },
      createdBy: actor?.id ?? null,
    });
    await this.jobs.update(job.id, { status: 'succeeded' });
  }
}

/** Migration ledgers (`*_schema_migrations`, `*_migrations`) are never restored. */
function isLedger(table: string): boolean {
  return table.endsWith('migrations');
}
