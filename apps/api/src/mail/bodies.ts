import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { SqlClient } from '@aspec/db';
import { UnprocessableError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ALL_TENANTS_SCOPE, PLATFORM_SCOPE } from '../directory/index.js';
import type { Platform } from '../platform.js';
import { afterCommit, runDetached, scopedClient } from '../tenancy.js';
import { SettingsStore } from './store.js';

const KEY = 'message-storage';
/** Settings are re-read this often, so every node follows a change within seconds. */
const SETTINGS_TTL_MS = 15_000;
/** Messages moved per batch, and how often the leader looks for more. */
const MOVE_BATCH = 50;
const MOVE_INTERVAL_MS = 30_000;
/** Objects nobody refers to are deleted only after this long, so restoring a recent backup finds them. */
const ORPHAN_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Small read cache per node, for IMAP clients that fetch the same message several times. */
const CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_ITEM_BYTES = 2 * 1024 * 1024;

export const BODY_STORAGE_KINDS = ['database', 's3'] as const;
export type BodyStorageKind = (typeof BODY_STORAGE_KINDS)[number];

interface StoredBodySettings {
  kind: BodyStorageKind;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  /** Encrypted. */
  secretAccessKey: string | null;
  forcePathStyle: boolean;
  lastError?: string | null;
  lastSweepAt?: number | null;
}

export interface BodyStorageView {
  kind: BodyStorageKind;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  hasSecret: boolean;
  forcePathStyle: boolean;
  lastError: string | null;
  /** Where the original messages are now; the leader moves them to match the setting. */
  inDatabase: { messages: number; bytes: number };
  inBucket: { messages: number; bytes: number };
}

export interface BodyStorageInput {
  kind: BodyStorageKind;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
}

const DEFAULTS: StoredBodySettings = {
  kind: 'database',
  endpoint: '',
  region: 'auto',
  bucket: '',
  prefix: '',
  accessKeyId: '',
  secretAccessKey: null,
  forcePathStyle: false,
};

type Row = Record<string, unknown>;
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));

async function toBuffer(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/**
 * Where the original copy (raw MIME, attachments included) of each message is kept. By default
 * it is a column of `aspectenant_messages`. With an S3-compatible bucket (Cloudflare R2, S3,
 * Backblaze B2, MinIO) new messages go to the bucket and only the key stays in the database,
 * so the database stays small enough for a hosted PostgreSQL such as Neon. The leader moves
 * existing messages across in the background, in either direction. If the bucket cannot be
 * reached, mail is still delivered and kept in the database, to be moved later.
 */
export class MessageBodies {
  private readonly platform: Platform;
  private readonly settings: SettingsStore;
  /** Every tenant's messages, for the background mover only. */
  private readonly all: SqlClient;
  private cached: { at: number; value: StoredBodySettings } | null = null;
  private client: { signature: string; client: S3Client } | null = null;
  private readonly cache = new Map<string, Buffer>();
  private cacheBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  /** The move in progress, so a second request waits for it instead of starting another. */
  private moving: Promise<number> | null = null;

  constructor(platform: Platform) {
    this.platform = platform;
    this.settings = new SettingsStore(scopedClient(platform, PLATFORM_SCOPE));
    this.all = scopedClient(platform, ALL_TENANTS_SCOPE);
  }

  private async load(fresh = false): Promise<StoredBodySettings> {
    if (!fresh && this.cached && Date.now() - this.cached.at < SETTINGS_TTL_MS) {
      return this.cached.value;
    }
    const stored = await this.settings.get<Partial<StoredBodySettings>>(PLATFORM_SCOPE, KEY);
    const value = { ...DEFAULTS, ...(stored ?? {}) };
    this.cached = { at: Date.now(), value };
    return value;
  }

  /** Forget cached settings (after a save here or on another node). */
  invalidate(): void {
    this.cached = null;
  }

  private bucketOf(stored: StoredBodySettings): { client: S3Client; bucket: string } | null {
    if (!stored.bucket || !stored.accessKeyId || !stored.secretAccessKey) return null;
    const signature = JSON.stringify([
      stored.endpoint,
      stored.region,
      stored.accessKeyId,
      stored.secretAccessKey,
      stored.forcePathStyle,
    ]);
    if (this.client?.signature !== signature) {
      this.client?.client.destroy();
      this.client = {
        signature,
        client: new S3Client({
          ...(stored.endpoint ? { endpoint: stored.endpoint } : {}),
          region: stored.region || 'auto',
          forcePathStyle: stored.forcePathStyle,
          credentials: {
            accessKeyId: stored.accessKeyId,
            secretAccessKey: this.platform.secrets.decrypt(stored.secretAccessKey),
          },
        }),
      };
    }
    return { client: this.client.client, bucket: stored.bucket };
  }

  private root(stored: StoredBodySettings): string {
    return `${stored.prefix}messages/`;
  }

  /**
   * Stores a new message's original copy in the bucket and returns its key, or null to keep it
   * in the database (storage set to database, or the bucket failed).
   */
  async put(tenantId: string, raw: Uint8Array): Promise<string | null> {
    const stored = await this.load();
    if (stored.kind !== 's3') return null;
    const target = this.bucketOf(stored);
    if (!target) return null;
    const month = new Date().toISOString().slice(0, 7);
    const key = `${this.root(stored)}${tenantId}/${month}/${randomUUID()}.eml`;
    try {
      await target.client.send(
        new PutObjectCommand({
          Bucket: target.bucket,
          Key: key,
          Body: raw,
          ContentType: 'message/rfc822',
        }),
      );
      return key;
    } catch (error) {
      this.platform.logger.warn(
        { err: error },
        'message storage bucket unavailable; keeping the message in the database for now',
      );
      return null;
    }
  }

  /** Reads a message's original copy from the bucket. */
  async get(key: string): Promise<Buffer> {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const target = this.bucketOf(await this.load());
    if (!target) throw new Error('Message storage has no bucket credentials.');
    const result = await target.client.send(
      new GetObjectCommand({ Bucket: target.bucket, Key: key }),
    );
    const bytes = await toBuffer(result.Body);
    if (bytes.byteLength <= CACHE_ITEM_BYTES) {
      this.cache.set(key, bytes);
      this.cacheBytes += bytes.byteLength;
      for (const [old, value] of this.cache) {
        if (this.cacheBytes <= CACHE_BYTES) break;
        this.cache.delete(old);
        this.cacheBytes -= value.byteLength;
      }
    }
    return bytes;
  }

  async view(): Promise<BodyStorageView> {
    const stored = await this.load(true);
    const counts = await this.all.query<Row>(
      `SELECT
         SUM(CASE WHEN raw_key IS NULL THEN 1 ELSE 0 END) AS db_count,
         SUM(CASE WHEN raw_key IS NULL THEN size_bytes ELSE 0 END) AS db_bytes,
         SUM(CASE WHEN raw_key IS NULL THEN 0 ELSE 1 END) AS bucket_count,
         SUM(CASE WHEN raw_key IS NULL THEN 0 ELSE size_bytes END) AS bucket_bytes
       FROM aspectenant_messages`,
    );
    const row = counts.rows[0] ?? {};
    return {
      kind: stored.kind,
      endpoint: stored.endpoint,
      region: stored.region,
      bucket: stored.bucket,
      prefix: stored.prefix,
      accessKeyId: stored.accessKeyId,
      hasSecret: Boolean(stored.secretAccessKey),
      forcePathStyle: stored.forcePathStyle,
      lastError: stored.lastError ?? null,
      inDatabase: { messages: num(row.db_count), bytes: num(row.db_bytes) },
      inBucket: { messages: num(row.bucket_count), bytes: num(row.bucket_bytes) },
    };
  }

  /** Checks the bucket accepts, returns and deletes an object with these settings. */
  async test(input?: BodyStorageInput): Promise<void> {
    const stored = input ? await this.merge(input) : await this.load(true);
    const target = this.bucketOf(stored);
    if (!target) throw new UnprocessableError('Enter the bucket, access key ID and secret.');
    const key = `${this.root(stored)}.aspectenant-test-${randomUUID()}`;
    try {
      await target.client.send(
        new PutObjectCommand({ Bucket: target.bucket, Key: key, Body: 'ok' }),
      );
      await target.client.send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
      await target.client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: key }));
    } catch (error) {
      throw new UnprocessableError(
        `The bucket test failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async merge(input: BodyStorageInput): Promise<StoredBodySettings> {
    const current = await this.load(true);
    const secret = input.secretAccessKey?.trim();
    return {
      ...current,
      kind: input.kind,
      endpoint: input.endpoint.trim().replace(/\/+$/, ''),
      region: input.region.trim() || 'auto',
      bucket: input.bucket.trim(),
      prefix: input.prefix.trim().replace(/^\/+/, ''),
      accessKeyId: input.accessKeyId.trim(),
      secretAccessKey: secret ? this.platform.secrets.encrypt(secret) : current.secretAccessKey,
      forcePathStyle: input.forcePathStyle,
    };
  }

  async save(input: BodyStorageInput, actor: Actor): Promise<BodyStorageView> {
    const next = await this.merge(input);
    if (next.prefix && !next.prefix.endsWith('/')) next.prefix = `${next.prefix}/`;
    if (next.kind === 's3') await this.test(input);
    const before = await this.load(true);
    if (before.prefix !== next.prefix || before.bucket !== next.bucket) {
      const moved = await this.all.query<Row>(
        'SELECT COUNT(*) AS n FROM aspectenant_messages WHERE raw_key IS NOT NULL',
      );
      if (num(moved.rows[0]?.n) > 0) {
        throw new UnprocessableError(
          'Messages are already stored in the current bucket. Move them back to the database first (set storage to the database and wait), then change the bucket.',
        );
      }
    }
    await this.settings.set(PLATFORM_SCOPE, KEY, { ...next, lastError: null });
    this.invalidate();
    await this.platform.cluster.signal('message-storage').catch(() => undefined);
    await this.platform.audit.record({
      action: 'platform.message_storage.updated',
      outcome: 'success',
      category: 'admin',
      actor,
      resource: { type: 'message-storage', id: KEY },
      changes: {
        after: {
          kind: next.kind,
          endpoint: next.endpoint,
          bucket: next.bucket,
          prefix: next.prefix,
          secret: input.secretAccessKey?.trim() ? 'replaced' : 'unchanged',
        },
      },
    });
    // Start moving once this request's writes are committed, outside its transaction.
    afterCommit(() => runDetached(async () => void (await this.moveNow())));
    return this.view();
  }

  start(): void {
    this.timer = setInterval(() => void this.moveNow(), MOVE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.client?.client.destroy();
    this.client = null;
  }

  /** Moves messages to where the setting says, on the leading node only. Returns how many. */
  async moveNow(): Promise<number> {
    if (this.moving) return this.moving;
    if (!this.platform.cluster.isLeader()) return 0;
    this.moving = this.move().finally(() => {
      this.moving = null;
    });
    return this.moving;
  }

  private async move(): Promise<number> {
    let moved = 0;
    try {
      const stored = await this.load(true);
      const target = this.bucketOf(stored);
      if (!target) return 0;
      for (;;) {
        const batch = stored.kind === 's3' ? await this.toBucket(stored) : await this.toDatabase();
        moved += batch;
        if (batch < MOVE_BATCH || !this.platform.cluster.isLeader()) break;
      }
      if (stored.lastError) await this.saveState({ lastError: null });
      if (stored.kind === 's3' && Date.now() - (stored.lastSweepAt ?? 0) > SWEEP_INTERVAL_MS) {
        await this.sweep(stored);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.platform.logger.warn({ err: error }, 'moving message storage failed; retrying later');
      await this.saveState({ lastError: message }).catch(() => undefined);
    }
    if (moved > 0) this.platform.logger.info({ moved }, 'message storage moved messages');
    return moved;
  }

  private async saveState(patch: Partial<StoredBodySettings>): Promise<void> {
    const current = await this.load(true);
    await this.settings.set(PLATFORM_SCOPE, KEY, { ...current, ...patch });
    this.invalidate();
  }

  private async toBucket(stored: StoredBodySettings): Promise<number> {
    const rows = await this.all.query<Row>(
      `SELECT id, tenant_id, raw FROM aspectenant_messages WHERE raw_key IS NULL LIMIT ${MOVE_BATCH}`,
    );
    const target = this.bucketOf(stored);
    if (!target) return 0;
    for (const row of rows.rows) {
      const raw = Buffer.isBuffer(row.raw) ? row.raw : Buffer.from(row.raw as Uint8Array);
      const month = new Date().toISOString().slice(0, 7);
      const key = `${this.root(stored)}${String(row.tenant_id)}/${month}/${randomUUID()}.eml`;
      await target.client.send(
        new PutObjectCommand({
          Bucket: target.bucket,
          Key: key,
          Body: raw,
          ContentType: 'message/rfc822',
        }),
      );
      await this.all.query(
        `UPDATE aspectenant_messages SET raw_key = $1, raw = $2 WHERE id = $3 AND raw_key IS NULL`,
        [key, Buffer.alloc(0), String(row.id)],
      );
    }
    return rows.rows.length;
  }

  private async toDatabase(): Promise<number> {
    const rows = await this.all.query<Row>(
      `SELECT id, raw_key FROM aspectenant_messages WHERE raw_key IS NOT NULL LIMIT ${MOVE_BATCH}`,
    );
    for (const row of rows.rows) {
      const key = String(row.raw_key);
      const raw = await this.get(key);
      await this.all.query(
        `UPDATE aspectenant_messages SET raw = $1, raw_key = NULL WHERE id = $2 AND raw_key = $3`,
        [raw, String(row.id), key],
      );
    }
    return rows.rows.length;
  }

  /**
   * Deletes objects no message refers to any more (deleted messages and mailboxes), once they
   * are older than the grace period. Only `.eml` objects under this installation's prefix.
   */
  private async sweep(stored: StoredBodySettings): Promise<void> {
    const target = this.bucketOf(stored);
    if (!target) return;
    const used = new Set<string>();
    const rows = await this.all.query<Row>(
      'SELECT raw_key FROM aspectenant_messages WHERE raw_key IS NOT NULL',
    );
    for (const row of rows.rows) used.add(String(row.raw_key));
    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    let removed = 0;
    let token: string | undefined;
    do {
      const page = await target.client.send(
        new ListObjectsV2Command({
          Bucket: target.bucket,
          Prefix: this.root(stored),
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const item of page.Contents ?? []) {
        const key = item.Key ?? '';
        if (!key.endsWith('.eml') || used.has(key)) continue;
        if ((item.LastModified?.getTime() ?? Date.now()) > cutoff) continue;
        await target.client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: key }));
        removed += 1;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    await this.saveState({ lastSweepAt: Date.now() });
    if (removed > 0) this.platform.logger.info({ removed }, 'removed unused stored messages');
  }
}
