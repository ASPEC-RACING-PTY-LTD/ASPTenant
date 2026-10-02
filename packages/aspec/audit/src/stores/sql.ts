import { canonicalJson } from '../canonical.js';
import { AuditError } from '../errors.js';
import type { SqlClient } from '../ports.js';
import {
  type AuditQueryResult,
  encodeCursor,
  type NormalisedFilter,
  type NormalisedQuery,
} from '../query.js';
import type { AuditStore, PurgeOptions, ReadStreamResult, StreamPurgeResult } from '../store.js';
import type {
  AuditCategory,
  AuditCheckpoint,
  AuditEvent,
  ChainHead,
  ChainIssue,
  VerifyRange,
} from '../types.js';

export interface Migration {
  id: string;
  postgres: string;
  sqlite: string;
}

export interface SqlAuditStoreOptions {
  /** Table name prefix. Default `audit_`. */
  tablePrefix?: string;
  /**
   * Delete through the `<prefix>purge_stream` function created by installAppendOnlyTrigger()
   * (PostgreSQL only). Required once the trigger is installed. Default false.
   */
  useRetentionFunction?: boolean;
}

export interface SqlAuditStore extends AuditStore {
  /** Applies pending migrations for this store's prefix. */
  migrate(): Promise<void>;
  readonly tablePrefix: string;
}

const PREFIX = /^[a-z][a-z0-9_]{0,30}$/;
const GENESIS = '0'.repeat(64);

function checkPrefix(prefix: string): string {
  if (!PREFIX.test(prefix)) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'tablePrefix must match ^[a-z][a-z0-9_]{0,30}$');
  }
  return prefix;
}

/** Migrations for a table prefix. */
export function migrationsFor(tablePrefix = 'audit_'): readonly Migration[] {
  const p = checkPrefix(tablePrefix);
  const indexes = (big: string) => `
CREATE INDEX IF NOT EXISTS ${p}events_ts_idx ON ${p}events (ts, id);
CREATE INDEX IF NOT EXISTS ${p}events_tenant_idx ON ${p}events (tenant_id, ts);
CREATE INDEX IF NOT EXISTS ${p}events_actor_idx ON ${p}events (actor_id, ts);
CREATE INDEX IF NOT EXISTS ${p}events_resource_idx ON ${p}events (resource_type, resource_id, ts);
CREATE INDEX IF NOT EXISTS ${p}events_action_idx ON ${p}events (action, ts);
CREATE INDEX IF NOT EXISTS ${p}events_category_idx ON ${p}events (category, ts);
CREATE INDEX IF NOT EXISTS ${p}events_request_idx ON ${p}events (request_id);
CREATE TABLE IF NOT EXISTS ${p}stream_heads (
  stream TEXT PRIMARY KEY,
  seq ${big} NOT NULL,
  hash TEXT NOT NULL,
  updated_at ${big} NOT NULL
);
CREATE TABLE IF NOT EXISTS ${p}checkpoints (
  id TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  kind TEXT NOT NULL,
  seq ${big} NOT NULL,
  created_at ${big} NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${p}checkpoints_stream_idx ON ${p}checkpoints (stream, seq);`;
  const columns = (big: string) => `
  id TEXT NOT NULL UNIQUE,
  stream TEXT NOT NULL,
  seq ${big} NOT NULL,
  ts ${big} NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  category TEXT NOT NULL,
  actor_id TEXT,
  actor_type TEXT,
  resource_type TEXT,
  resource_id TEXT,
  tenant_id TEXT,
  request_id TEXT,
  correlation_id TEXT,
  hash TEXT NOT NULL,
  record TEXT NOT NULL,
  CONSTRAINT ${p}events_stream_seq_key UNIQUE (stream, seq)`;
  return [
    {
      id: '0001_audit_events',
      postgres: `CREATE TABLE IF NOT EXISTS ${p}events (
  pos BIGSERIAL PRIMARY KEY,${columns('BIGINT')}
);${indexes('BIGINT')}`,
      sqlite: `CREATE TABLE IF NOT EXISTS ${p}events (
  pos INTEGER PRIMARY KEY AUTOINCREMENT,${columns('INTEGER')}
);${indexes('INTEGER')}`,
    },
  ];
}

/** Migrations for the default `audit_` prefix. */
export const migrations: readonly Migration[] = migrationsFor('audit_');

/** Applies pending migrations idempotently, tracked in `<prefix>schema_migrations`. */
export async function migrate(
  client: SqlClient,
  options: { tablePrefix?: string } = {},
): Promise<void> {
  const p = checkPrefix(options.tablePrefix ?? 'audit_');
  const big = client.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${p}schema_migrations (id TEXT PRIMARY KEY, applied_at ${big} NOT NULL)`,
  );
  await client.transaction(async (tx) => {
    if (tx.dialect === 'postgres') {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${p}schema_migrations`]);
    }
    const applied = await tx.query<{ id: string }>(`SELECT id FROM ${p}schema_migrations`);
    const done = new Set(applied.rows.map((r) => r.id));
    for (const m of migrationsFor(p)) {
      if (done.has(m.id)) continue;
      await tx.query(tx.dialect === 'postgres' ? m.postgres : m.sqlite);
      await tx.query(`INSERT INTO ${p}schema_migrations (id, applied_at) VALUES ($1, $2)`, [
        m.id,
        Date.now(),
      ]);
    }
  });
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * PostgreSQL only. Installs triggers that reject UPDATE, DELETE and TRUNCATE on the events and
 * checkpoints tables, and a SECURITY DEFINER function `<prefix>purge_stream(stream, through_seq)`
 * that is the only way to delete events. Combine with REVOKE UPDATE, DELETE on the tables from
 * the application role (see docs/security.md).
 */
export async function installAppendOnlyTrigger(
  client: SqlClient,
  options: { tablePrefix?: string } = {},
): Promise<void> {
  if (client.dialect !== 'postgres') {
    throw new AuditError(
      'AUDIT_INVALID_OPTIONS',
      'installAppendOnlyTrigger supports PostgreSQL only',
    );
  }
  const p = checkPrefix(options.tablePrefix ?? 'audit_');
  const schema = (await client.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]?.s;
  if (!schema) throw new AuditError('AUDIT_INVALID_OPTIONS', 'cannot determine the current schema');
  const sp = quoteIdent(schema);
  await client.query(`
CREATE OR REPLACE FUNCTION ${sp}.${p}reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = '${p}events' AND current_setting('aspec_audit.purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit tables are append-only: % on % rejected', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;
DROP TRIGGER IF EXISTS ${p}events_append_only ON ${sp}.${p}events;
CREATE TRIGGER ${p}events_append_only BEFORE UPDATE OR DELETE ON ${sp}.${p}events
  FOR EACH ROW EXECUTE FUNCTION ${sp}.${p}reject_mutation();
DROP TRIGGER IF EXISTS ${p}events_no_truncate ON ${sp}.${p}events;
CREATE TRIGGER ${p}events_no_truncate BEFORE TRUNCATE ON ${sp}.${p}events
  FOR EACH STATEMENT EXECUTE FUNCTION ${sp}.${p}reject_mutation();
DROP TRIGGER IF EXISTS ${p}checkpoints_append_only ON ${sp}.${p}checkpoints;
CREATE TRIGGER ${p}checkpoints_append_only BEFORE UPDATE OR DELETE ON ${sp}.${p}checkpoints
  FOR EACH ROW EXECUTE FUNCTION ${sp}.${p}reject_mutation();
DROP TRIGGER IF EXISTS ${p}checkpoints_no_truncate ON ${sp}.${p}checkpoints;
CREATE TRIGGER ${p}checkpoints_no_truncate BEFORE TRUNCATE ON ${sp}.${p}checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION ${sp}.${p}reject_mutation();
CREATE OR REPLACE FUNCTION ${sp}.${p}purge_stream(p_stream text, p_through bigint) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ${sp} AS $fn$
DECLARE n bigint;
BEGIN
  PERFORM set_config('aspec_audit.purge', 'on', true);
  DELETE FROM ${sp}.${p}events WHERE stream = p_stream AND seq <= p_through;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('aspec_audit.purge', 'off', true);
  RETURN n;
END
$fn$;`);
}

interface EventRow {
  record: string;
  id?: string;
  stream?: string;
  seq?: number | string;
  ts?: number | string;
  action?: string;
  outcome?: string;
  category?: string;
  actor_id?: string | null;
  actor_type?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  tenant_id?: string | null;
  request_id?: string | null;
  correlation_id?: string | null;
  hash?: string;
}

function parseRecord(record: string): AuditEvent {
  return JSON.parse(record) as AuditEvent;
}

function columnMismatch(row: EventRow, e: AuditEvent): string | undefined {
  const pairs: [string, unknown, unknown][] = [
    ['id', row.id, e.id],
    ['stream', row.stream, e.stream],
    ['seq', Number(row.seq), e.seq],
    ['ts', Number(row.ts), e.timestamp],
    ['action', row.action, e.action],
    ['outcome', row.outcome, e.outcome],
    ['category', row.category, e.category],
    ['actor_id', row.actor_id ?? undefined, e.actor?.id],
    ['actor_type', row.actor_type ?? undefined, e.actor?.type],
    ['resource_type', row.resource_type ?? undefined, e.resource?.type],
    ['resource_id', row.resource_id ?? undefined, e.resource?.id],
    ['tenant_id', row.tenant_id ?? undefined, e.tenantId],
    ['request_id', row.request_id ?? undefined, e.requestId],
    ['correlation_id', row.correlation_id ?? undefined, e.correlationId],
    ['hash', row.hash, e.hash],
  ];
  const bad = pairs.filter(([, a, b]) => a !== b).map(([n]) => n);
  return bad.length ? bad.join(', ') : undefined;
}

/** SQL store for PostgreSQL and SQLite over the SqlClient port. Append-only by design. */
export function createSqlAuditStore(
  client: SqlClient,
  options: SqlAuditStoreOptions = {},
): SqlAuditStore {
  const p = checkPrefix(options.tablePrefix ?? 'audit_');
  const pg = client.dialect === 'postgres';
  if (client.dialect !== 'postgres' && client.dialect !== 'sqlite') {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'SqlClient.dialect must be postgres or sqlite');
  }
  if (options.useRetentionFunction && !pg) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'useRetentionFunction requires PostgreSQL');
  }
  const E = `${p}events`;
  const H = `${p}stream_heads`;
  const C = `${p}checkpoints`;
  const collate = pg ? ' COLLATE "C"' : '';
  const INSERT_EVENT = `INSERT INTO ${E} (id, stream, seq, ts, action, outcome, category, actor_id, actor_type, resource_type, resource_id, tenant_id, request_id, correlation_id, hash, record) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`;

  const eventParams = (e: AuditEvent): unknown[] => [
    e.id,
    e.stream,
    e.seq,
    e.timestamp,
    e.action,
    e.outcome,
    e.category,
    e.actor?.id ?? null,
    e.actor?.type ?? null,
    e.resource?.type ?? null,
    e.resource?.id ?? null,
    e.tenantId ?? null,
    e.requestId ?? null,
    e.correlationId ?? null,
    e.hash,
    canonicalJson(e),
  ];

  const lockHead = async (
    tx: SqlClient,
    stream: string,
    now: number,
  ): Promise<ChainHead | undefined> => {
    await tx.query(
      `INSERT INTO ${H} (stream, seq, hash, updated_at) VALUES ($1, 0, $2, $3) ON CONFLICT (stream) DO NOTHING`,
      [stream, GENESIS, now],
    );
    const r = await tx.query<{ seq: number | string; hash: string }>(
      `SELECT seq, hash FROM ${H} WHERE stream = $1${pg ? ' FOR UPDATE' : ''}`,
      [stream],
    );
    const row = r.rows[0];
    if (!row || Number(row.seq) === 0) return undefined;
    return { stream, seq: Number(row.seq), hash: row.hash };
  };

  const buildWhere = (f: NormalisedFilter, params: unknown[]): string[] => {
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.actorId !== undefined) add('actor_id = ?', f.actorId);
    if (f.actorType !== undefined) add('actor_type = ?', f.actorType);
    if (f.action !== undefined) add('action = ?', f.action);
    if (f.actionPrefix !== undefined) {
      params.push(f.actionPrefix.length);
      const lenParam = `$${params.length}`;
      params.push(f.actionPrefix);
      where.push(`substr(action, 1, CAST(${lenParam} AS INTEGER)) = $${params.length}`);
    }
    if (f.resourceType !== undefined) add('resource_type = ?', f.resourceType);
    if (f.resourceId !== undefined) add('resource_id = ?', f.resourceId);
    if (f.tenantId !== undefined) add('tenant_id = ?', f.tenantId);
    if (f.outcome !== undefined) add('outcome = ?', f.outcome);
    if (f.category !== undefined) add('category = ?', f.category);
    if (f.requestId !== undefined) add('request_id = ?', f.requestId);
    if (f.correlationId !== undefined) add('correlation_id = ?', f.correlationId);
    if (f.stream !== undefined) add('stream = ?', f.stream);
    if (f.from !== undefined) add('ts >= CAST(? AS BIGINT)', f.from);
    if (f.to !== undefined) add('ts < CAST(? AS BIGINT)', f.to);
    return where;
  };

  const readCheckpoints = async (tx: SqlClient, stream: string): Promise<AuditCheckpoint[]> => {
    const r = await tx.query<{ record: string }>(
      `SELECT record FROM ${C} WHERE stream = $1 ORDER BY seq, created_at`,
      [stream],
    );
    return r.rows.map((row) => JSON.parse(row.record) as AuditCheckpoint);
  };

  const store: SqlAuditStore = {
    kind: 'audit-store',
    name: `sql:${client.dialect}`,
    tablePrefix: p,
    migrate: () => migrate(client, { tablePrefix: p }),

    async write(events) {
      if (events.length === 0) return;
      await client.transaction(async (tx) => {
        for (const e of events) {
          await tx.query(INSERT_EVENT, eventParams(e));
          await tx.query(
            `INSERT INTO ${H} (stream, seq, hash, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (stream) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, updated_at = excluded.updated_at WHERE ${H}.seq < excluded.seq`,
            [e.stream, e.seq, e.hash, e.timestamp],
          );
        }
      });
    },

    async recoverHeads() {
      const r = await client.query<{ stream: string; seq: number | string; hash: string }>(
        `SELECT stream, seq, hash FROM ${H} WHERE seq > 0`,
      );
      return r.rows.map((row) => ({ stream: row.stream, seq: Number(row.seq), hash: row.hash }));
    },

    async appendChained(stream, build) {
      return client.transaction(async (tx) => {
        const head = await lockHead(tx, stream, Date.now());
        const event = build(head);
        if (event.stream !== stream || event.seq !== (head?.seq ?? 0) + 1) {
          throw new AuditError(
            'AUDIT_CHAIN_CONFLICT',
            'built event does not continue the stream head',
          );
        }
        await tx.query(INSERT_EVENT, eventParams(event));
        await tx.query(`UPDATE ${H} SET seq = $2, hash = $3, updated_at = $4 WHERE stream = $1`, [
          stream,
          event.seq,
          event.hash,
          event.timestamp,
        ]);
        return event;
      });
    },

    async query(q: NormalisedQuery): Promise<AuditQueryResult> {
      const params: unknown[] = [];
      const where = buildWhere(q.filter, params);
      const desc = q.order === 'desc';
      if (q.after) {
        params.push(q.after.timestamp);
        const t = `CAST($${params.length} AS BIGINT)`;
        params.push(q.after.id);
        const i = `$${params.length}`;
        const op = desc ? '<' : '>';
        where.push(`(ts ${op} ${t} OR (ts = ${t} AND id${collate} ${op} ${i}))`);
      }
      params.push(q.limit + 1);
      const dir = desc ? 'DESC' : 'ASC';
      const sql = `SELECT record FROM ${E}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts ${dir}, id${collate} ${dir} LIMIT $${params.length}`;
      const r = await client.query<{ record: string }>(sql, params);
      const events = r.rows.slice(0, q.limit).map((row) => parseRecord(row.record));
      const result: AuditQueryResult = { events };
      const last = events[events.length - 1];
      if (r.rows.length > q.limit && last) result.nextCursor = encodeCursor(q.order, last);
      return result;
    },

    async count(f) {
      const params: unknown[] = [];
      const where = buildWhere(f, params);
      const r = await client.query<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM ${E}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
        params,
      );
      return Number(r.rows[0]?.n ?? 0);
    },

    async getById(id) {
      const r = await client.query<{ record: string }>(`SELECT record FROM ${E} WHERE id = $1`, [
        id,
      ]);
      const row = r.rows[0];
      return row ? parseRecord(row.record) : undefined;
    },

    async listStreams() {
      const r = await client.query<{ stream: string }>(
        `SELECT stream FROM ${H} ORDER BY stream${collate}`,
      );
      return r.rows.map((row) => row.stream);
    },

    async getHead(stream) {
      const r = await client.query<{ seq: number | string; hash: string }>(
        `SELECT seq, hash FROM ${H} WHERE stream = $1`,
        [stream],
      );
      const row = r.rows[0];
      if (!row || Number(row.seq) === 0) return undefined;
      return { stream, seq: Number(row.seq), hash: row.hash };
    },

    async readStream(stream: string, range: VerifyRange): Promise<ReadStreamResult> {
      const params: unknown[] = [stream];
      let sql = `SELECT * FROM ${E} WHERE stream = $1`;
      if (range.fromSeq !== undefined) {
        params.push(range.fromSeq);
        sql += ` AND seq >= CAST($${params.length} AS BIGINT)`;
      }
      if (range.toSeq !== undefined) {
        params.push(range.toSeq);
        sql += ` AND seq <= CAST($${params.length} AS BIGINT)`;
      }
      sql += ' ORDER BY pos';
      const r = await client.query<EventRow>(sql, params);
      const issues: ChainIssue[] = [];
      const events: AuditEvent[] = [];
      for (const row of r.rows) {
        let e: AuditEvent;
        try {
          e = parseRecord(row.record);
        } catch {
          issues.push({
            kind: 'modified',
            seq: Number(row.seq),
            ...(row.id ? { eventId: row.id } : {}),
            message: 'stored record is not valid JSON',
          });
          continue;
        }
        const bad = columnMismatch(row, e);
        if (bad) {
          issues.push({
            kind: 'modified',
            seq: Number(row.seq),
            eventId: e.id,
            message: `indexed columns disagree with the stored record (${bad})`,
          });
        }
        events.push(e);
      }
      return issues.length ? { events, issues } : { events };
    },

    listCheckpoints: (stream) => readCheckpoints(client, stream),

    async saveCheckpoint(cp) {
      await client.query(
        `INSERT INTO ${C} (id, stream, kind, seq, created_at, record) VALUES ($1, $2, $3, $4, $5, $6)`,
        [cp.id, cp.stream, cp.kind, cp.seq, cp.createdAt, canonicalJson(cp)],
      );
    },

    async purge(stream: string, opts: PurgeOptions): Promise<StreamPurgeResult> {
      return client.transaction(async (tx) => {
        await lockHead(tx, stream, opts.now);
        const cut = (c: AuditCategory) => opts.cutoffs[c];
        const cutoffParams = [cut('security'), cut('data'), cut('admin'), cut('system')];
        const threshold =
          "CASE category WHEN 'security' THEN CAST($2 AS BIGINT) WHEN 'data' THEN CAST($3 AS BIGINT) WHEN 'admin' THEN CAST($4 AS BIGINT) ELSE CAST($5 AS BIGINT) END";
        const minKeep = await tx.query<{ m: number | string | null }>(
          `SELECT MIN(seq) AS m FROM ${E} WHERE stream = $1 AND ts >= ${threshold}`,
          [stream, ...cutoffParams],
        );
        const keepFrom = minKeep.rows[0]?.m;
        const lastRow = await tx.query<{ seq: number | string; hash: string }>(
          keepFrom === null || keepFrom === undefined
            ? `SELECT seq, hash FROM ${E} WHERE stream = $1 ORDER BY seq DESC LIMIT 1`
            : `SELECT seq, hash FROM ${E} WHERE stream = $1 AND seq < CAST($2 AS BIGINT) ORDER BY seq DESC LIMIT 1`,
          keepFrom === null || keepFrom === undefined ? [stream] : [stream, Number(keepFrom)],
        );
        const last = lastRow.rows[0];
        const result: StreamPurgeResult = { stream, purged: 0, expiredRetained: 0 };
        if (keepFrom !== null && keepFrom !== undefined) {
          const retained = await tx.query<{ n: number | string }>(
            `SELECT COUNT(*) AS n FROM ${E} WHERE stream = $1 AND seq >= CAST($6 AS BIGINT) AND ts < ${threshold}`,
            [stream, ...cutoffParams, Number(keepFrom)],
          );
          result.expiredRetained = Number(retained.rows[0]?.n ?? 0);
        }
        if (!last) return result;
        const through = Number(last.seq);
        const countRow = await tx.query<{ n: number | string }>(
          `SELECT COUNT(*) AS n FROM ${E} WHERE stream = $1 AND seq <= CAST($2 AS BIGINT)`,
          [stream, through],
        );
        result.purged = Number(countRow.rows[0]?.n ?? 0);
        result.throughSeq = through;
        if (opts.dryRun || result.purged === 0) return result;
        if (options.useRetentionFunction) {
          await tx.query(`SELECT ${p}purge_stream($1, CAST($2 AS BIGINT)) AS n`, [stream, through]);
        } else {
          await tx.query(`DELETE FROM ${E} WHERE stream = $1 AND seq <= CAST($2 AS BIGINT)`, [
            stream,
            through,
          ]);
        }
        const previous = (await readCheckpoints(tx, stream))
          .filter((c) => c.kind !== 'manual')
          .pop();
        const cp = opts.seal({
          id: opts.generateId(),
          stream,
          kind: 'retention',
          seq: through,
          hash: last.hash,
          createdAt: opts.now,
          purgedCount: (previous?.purgedCount ?? 0) + result.purged,
        });
        await tx.query(
          `INSERT INTO ${C} (id, stream, kind, seq, created_at, record) VALUES ($1, $2, $3, $4, $5, $6)`,
          [cp.id, cp.stream, cp.kind, cp.seq, cp.createdAt, canonicalJson(cp)],
        );
        result.checkpoint = cp;
        return result;
      });
    },
  };
  return store;
}
