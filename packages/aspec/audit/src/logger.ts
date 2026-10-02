import { canonicalJson } from './canonical.js';
import {
  type ChainOptions,
  computeEventHash,
  GENESIS_HASH,
  hashParams,
  type ResolvedChainKeys,
  resolveChainKeys,
  sealCheckpoint,
  verifyEvents,
} from './chain.js';
import { getAuditContext } from './context.js';
import { computeDiff } from './diff.js';
import { AuditError } from './errors.js';
import { createUuidV7Generator } from './ids.js';
import { KeyedMutex } from './mutex.js';
import type { Clock, IdGenerator, LoggerLike } from './ports.js';
import {
  type AuditFilter,
  type AuditQuery,
  type AuditQueryResult,
  normaliseFilter,
  normaliseQuery,
} from './query.js';
import { cleanString, createRedactor, type Redactor, type RedactorOptions } from './redact.js';
import {
  type AuditEventSink,
  type AuditStore,
  type CheckpointSealer,
  isAuditStore,
  type StreamPurgeResult,
} from './store.js';
import {
  AUDIT_CATEGORIES,
  AUDIT_OUTCOMES,
  type AuditActor,
  type AuditCategory,
  type AuditChanges,
  type AuditCheckpoint,
  type AuditEvent,
  type AuditRecordInput,
  type ChainHead,
  type ChainVerificationReport,
  type VerifyRange,
} from './types.js';

export interface RetentionOptions {
  /** Days to keep events of categories without a specific rule. Default 90. */
  defaultDays?: number;
  /** Days per category, for example `{ security: 365 }`. */
  categories?: Partial<Record<AuditCategory, number>>;
}

export interface AuditLoggerOptions {
  /** One sink or store. */
  sink?: AuditEventSink;
  /** Several sinks. The first store (memory or SQL) is the chain authority and serves queries. */
  sinks?: readonly AuditEventSink[];
  /** Redaction options or a redactor from createRedactor(). */
  redact?: RedactorOptions | Redactor;
  clock?: Clock;
  /** Event ID generator. Default UUID v7 using the clock. */
  generateId?: IdGenerator;
  /** Hash chain keys (HMAC key, Ed25519 checkpoint keys). */
  chain?: ChainOptions;
  /** Maps an event to its hash chain stream. Default: category, plus `:tenantId` when set. */
  streamOf?: (event: { category: AuditCategory; tenantId?: string }) => string;
  retention?: RetentionOptions;
  /** Category of events that do not set one and do not match a security prefix. Default `system`. */
  defaultCategory?: AuditCategory;
  /** Actions starting with one of these prefixes default to the security category. */
  securityActionPrefixes?: readonly string[];
  /** Enrich events from the request audit context (AsyncLocalStorage). Default true. */
  useContext?: boolean;
  /** Maximum canonical JSON size of one event. Default 65536 bytes. */
  maxEventBytes?: number;
  /** Maximum number of diff entries per event. Default 200. */
  maxDiffEntries?: number;
  /** Receives secondary sink failures and resolver errors. Default no-op. */
  logger?: LoggerLike;
}

export interface RetentionResult {
  dryRun: boolean;
  purged: number;
  expiredRetained: number;
  cutoffs: Record<AuditCategory, number>;
  streams: StreamPurgeResult[];
}

export interface AuditLogger {
  /** Records one event (AuditSink port). Resolves with the stored event. */
  record(input: AuditRecordInput): Promise<AuditEvent>;
  /** Records an event in the security category. */
  recordSecurityEvent(input: Omit<AuditRecordInput, 'category'>): Promise<AuditEvent>;
  query(query?: AuditQuery): Promise<AuditQueryResult>;
  count(filter?: AuditFilter): Promise<number>;
  getEvent(id: string): Promise<AuditEvent | undefined>;
  listStreams(): Promise<string[]>;
  verifyChain(stream: string, range?: VerifyRange): Promise<ChainVerificationReport>;
  verifyAll(): Promise<ChainVerificationReport[]>;
  /** Writes a signed checkpoint attesting the current head of a stream. */
  createCheckpoint(stream: string): Promise<AuditCheckpoint>;
  applyRetention(options?: { now?: number; dryRun?: boolean }): Promise<RetentionResult>;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly redactor: Redactor;
  /** The store used for queries, verification and retention, if any. */
  readonly store: AuditStore | undefined;
}

const ACTION = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/;
const DAY = 86_400_000;
const NOOP_LOGGER: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

function invalid(message: string): never {
  throw new AuditError('AUDIT_INVALID_EVENT', message);
}

function str(name: string, value: unknown, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) invalid(`${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string') invalid(`${name} must be a string`);
  const s = cleanString(value).trim();
  if (s.length === 0) {
    if (required) invalid(`${name} must not be empty`);
    return undefined;
  }
  if (s.length > max) invalid(`${name} must be at most ${max} characters`);
  return s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function defaultStreamOf(e: { category: AuditCategory; tenantId?: string }): string {
  return e.tenantId ? `${e.category}:${e.tenantId}` : e.category;
}

function isRedactor(v: unknown): v is Redactor {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Redactor).redact === 'function' &&
    typeof (v as Redactor).isSensitiveKey === 'function'
  );
}

function days(name: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', `${name} must be a positive number of days`);
  }
  return v;
}

/** Creates the audit logger. It implements the AuditSink port. */
export function createAuditLogger(options: AuditLoggerOptions): AuditLogger {
  const sinks: AuditEventSink[] = [];
  if (options.sink) sinks.push(options.sink);
  if (options.sinks) sinks.push(...options.sinks);
  if (sinks.length === 0) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'createAuditLogger needs sink or sinks');
  }
  for (const s of sinks) {
    if (typeof s?.write !== 'function') {
      throw new AuditError('AUDIT_INVALID_OPTIONS', 'every sink must implement write(events)');
    }
  }
  const store = sinks.find(isAuditStore);
  const secondary = sinks.filter((s) => s !== store);
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const generateId = options.generateId ?? createUuidV7Generator(clock);
  const redactor = isRedactor(options.redact)
    ? options.redact
    : createRedactor((options.redact as RedactorOptions | undefined) ?? {});
  const keys: ResolvedChainKeys = resolveChainKeys(options.chain);
  const streamOf = options.streamOf ?? defaultStreamOf;
  const defaultCategory = options.defaultCategory ?? 'system';
  if (!AUDIT_CATEGORIES.includes(defaultCategory)) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'defaultCategory is not a valid category');
  }
  const securityPrefixes = options.securityActionPrefixes ?? ['auth.', 'security.'];
  const useContext = options.useContext ?? true;
  const maxEventBytes = options.maxEventBytes ?? 65536;
  const maxDiffEntries = options.maxDiffEntries ?? 200;
  if (!Number.isInteger(maxEventBytes) || maxEventBytes < 1024) {
    throw new AuditError(
      'AUDIT_INVALID_OPTIONS',
      'maxEventBytes must be an integer of at least 1024',
    );
  }
  if (!Number.isInteger(maxDiffEntries) || maxDiffEntries < 0) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'maxDiffEntries must be a non-negative integer');
  }
  const retentionDefault = days('retention.defaultDays', options.retention?.defaultDays ?? 90);
  const retentionByCategory: Record<AuditCategory, number> = {
    security: retentionDefault,
    data: retentionDefault,
    admin: retentionDefault,
    system: retentionDefault,
  };
  for (const [cat, d] of Object.entries(options.retention?.categories ?? {})) {
    if (!AUDIT_CATEGORIES.includes(cat as AuditCategory)) {
      throw new AuditError(
        'AUDIT_INVALID_OPTIONS',
        `retention.categories.${cat} is not a category`,
      );
    }
    retentionByCategory[cat as AuditCategory] = days(`retention.categories.${cat}`, d);
  }
  const log = options.logger ?? NOOP_LOGGER;

  const seal: CheckpointSealer = (body) => sealCheckpoint(body, keys);
  store?.attach?.({ sealCheckpoint: seal, generateId, now: () => clock.now() });

  const mutex = new KeyedMutex();
  const heads = new Map<string, ChainHead>();
  let headsRecovered: Promise<void> | undefined;
  let closed = false;

  const recoverHeads = (): Promise<void> => {
    headsRecovered ??= (async () => {
      for (const s of secondary) {
        if (!s.recoverHeads) continue;
        for (const h of await s.recoverHeads()) {
          const cur = heads.get(h.stream);
          if (!cur || h.seq > cur.seq) heads.set(h.stream, h);
        }
      }
    })();
    return headsRecovered;
  };

  async function resolveActor(input: AuditRecordInput): Promise<AuditActor | undefined> {
    const ctx = useContext ? getAuditContext() : undefined;
    let raw: AuditRecordInput['actor'] | null | undefined = input.actor ?? ctx?.actor;
    if (!raw && ctx?.resolveActor) {
      try {
        raw = await ctx.resolveActor();
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'audit actor resolver failed',
        );
      }
    }
    const ip = raw?.ip ?? ctx?.ip;
    const userAgent = raw?.userAgent ?? ctx?.userAgent;
    if (!raw && !ip && !userAgent) return undefined;
    const actor: AuditActor = raw
      ? { id: str('actor.id', raw.id, 256, true) as string }
      : { id: 'anonymous', type: 'anonymous' };
    const type = raw ? str('actor.type', raw.type, 64, false) : undefined;
    if (type) actor.type = type;
    const ipv = str('actor.ip', ip, 64, false);
    if (ipv) actor.ip = ipv;
    if (typeof userAgent === 'string' && userAgent.trim()) {
      actor.userAgent = cleanString(userAgent).trim().slice(0, 512);
    }
    return actor;
  }

  async function prepare(
    input: AuditRecordInput,
  ): Promise<Omit<AuditEvent, 'stream' | 'seq' | 'prevHash' | 'hash' | 'hashAlg'>> {
    if (!isPlainObject(input)) invalid('event must be an object');
    const action = str('action', input.action, 128, true) as string;
    if (!ACTION.test(action)) {
      invalid('action must be namespaced with dots, for example "auth.login.failed"');
    }
    const outcome = input.outcome ?? 'success';
    if (!AUDIT_OUTCOMES.includes(outcome))
      invalid(`outcome must be one of ${AUDIT_OUTCOMES.join(', ')}`);
    let category = input.category;
    if (category !== undefined && !AUDIT_CATEGORIES.includes(category)) {
      invalid(`category must be one of ${AUDIT_CATEGORIES.join(', ')}`);
    }
    if (category === undefined) {
      category =
        outcome === 'denied' || securityPrefixes.some((p) => action.startsWith(p))
          ? 'security'
          : defaultCategory;
    }
    const ctx = useContext ? getAuditContext() : undefined;
    const timestamp = clock.now();
    if (!Number.isFinite(timestamp)) invalid('clock returned an invalid time');
    const event: Omit<AuditEvent, 'stream' | 'seq' | 'prevHash' | 'hash' | 'hashAlg'> = {
      id: generateId(),
      timestamp,
      time: new Date(timestamp).toISOString(),
      action,
      outcome,
      category,
      security: category === 'security',
    };
    const actor = await resolveActor(input);
    if (actor) event.actor = actor;
    if (input.resource !== undefined) {
      if (!isPlainObject(input.resource)) invalid('resource must be an object');
      event.resource = { type: str('resource.type', input.resource.type, 128, true) as string };
      const rid = str('resource.id', input.resource.id, 256, false);
      if (rid) event.resource.id = rid;
    }
    const tenantId = str('tenantId', input.tenantId ?? ctx?.tenantId, 256, false);
    if (tenantId) event.tenantId = tenantId;
    const requestId = str('requestId', input.requestId ?? ctx?.requestId, 256, false);
    if (requestId) event.requestId = requestId;
    const correlationId = str(
      'correlationId',
      input.correlationId ?? ctx?.correlationId ?? requestId,
      256,
      false,
    );
    if (correlationId) event.correlationId = correlationId;
    if (input.changes !== undefined) {
      if (!isPlainObject(input.changes)) invalid('changes must be an object');
      const { before, after } = input.changes;
      const changes: AuditChanges = { diff: [] };
      if (before !== undefined) changes.before = redactor.redact(before);
      if (after !== undefined) changes.after = redactor.redact(after);
      const d = computeDiff(before, after, redactor, maxDiffEntries);
      changes.diff = d.diff;
      if (d.truncated) changes.diffTruncated = true;
      event.changes = changes;
    }
    if (input.metadata !== undefined) {
      if (!isPlainObject(input.metadata)) invalid('metadata must be a plain object');
      event.metadata = redactor.redact(input.metadata) as Record<string, unknown>;
    }
    return event;
  }

  function finalize(
    base: Omit<AuditEvent, 'stream' | 'seq' | 'prevHash' | 'hash' | 'hashAlg'>,
    stream: string,
    head: ChainHead | undefined,
  ): AuditEvent {
    const params = hashParams(keys);
    const unsigned: Omit<AuditEvent, 'hash'> = {
      ...base,
      stream,
      seq: (head?.seq ?? 0) + 1,
      prevHash: head?.hash ?? GENESIS_HASH,
      hashAlg: params.hashAlg,
    };
    if (params.keyId) unsigned.keyId = params.keyId;
    return { ...unsigned, hash: computeEventHash(unsigned, keys) };
  }

  async function writeSecondary(event: AuditEvent, required: boolean): Promise<void> {
    if (secondary.length === 0) return;
    const results = await Promise.allSettled(secondary.map((s) => s.write([event])));
    const failures = results.flatMap((r, i) =>
      r.status === 'rejected'
        ? [{ sink: secondary[i]?.name ?? `sink ${i}`, reason: r.reason }]
        : [],
    );
    for (const f of failures) {
      log.error(
        {
          sink: f.sink,
          eventId: event.id,
          err: f.reason instanceof Error ? f.reason.message : String(f.reason),
        },
        'audit sink write failed',
      );
    }
    if (required && failures.length === results.length) {
      throw new AuditError('AUDIT_SINK_FAILED', 'no audit sink accepted the event', {
        cause: failures[0]?.reason,
      });
    }
  }

  async function record(input: AuditRecordInput): Promise<AuditEvent> {
    if (closed) throw new AuditError('AUDIT_SINK_CLOSED', 'the audit logger is closed');
    const base = await prepare(input);
    const stream = cleanString(
      String(
        streamOf({
          category: base.category,
          ...(base.tenantId ? { tenantId: base.tenantId } : {}),
        }),
      ),
    );
    if (stream.length === 0 || stream.length > 300) {
      throw new AuditError('AUDIT_INVALID_OPTIONS', 'streamOf must return 1 to 300 characters');
    }
    const size = Buffer.byteLength(canonicalJson(base), 'utf8');
    if (size > maxEventBytes) {
      throw new AuditError(
        'AUDIT_EVENT_TOO_LARGE',
        `audit event is ${size} bytes; the limit is ${maxEventBytes} (reduce metadata or changes)`,
      );
    }
    if (store) {
      // The store serialises appends across processes; the in-process queue additionally keeps
      // secondary sinks in sequence order.
      return mutex.run(stream, async () => {
        const event = await store.appendChained(stream, (head) => finalize(base, stream, head));
        await writeSecondary(event, false);
        return event;
      });
    }
    await recoverHeads();
    return mutex.run(stream, async () => {
      const event = finalize(base, stream, heads.get(stream));
      await writeSecondary(event, true);
      heads.set(stream, { stream, seq: event.seq, hash: event.hash });
      return event;
    });
  }

  function requireStore(what: string): AuditStore {
    if (!store) {
      throw new AuditError(
        'AUDIT_NOT_QUERYABLE',
        `${what} needs a store sink (createMemoryAuditStore or createSqlAuditStore)`,
      );
    }
    return store;
  }

  async function verifyChain(
    stream: string,
    range: VerifyRange = {},
  ): Promise<ChainVerificationReport> {
    const s = requireStore('verifyChain');
    for (const [k, v] of Object.entries(range)) {
      if (v !== undefined && (!Number.isSafeInteger(v) || v < 1)) {
        throw new AuditError('AUDIT_INVALID_QUERY', `${k} must be a positive integer`);
      }
    }
    const [head, checkpoints] = await Promise.all([s.getHead(stream), s.listCheckpoints(stream)]);
    const readRange: VerifyRange = { ...range };
    if (range.fromSeq !== undefined && range.fromSeq > 1) readRange.fromSeq = range.fromSeq - 1;
    const read = await s.readStream(stream, readRange);
    let anchorEvent: AuditEvent | undefined;
    let events = read.events;
    if (range.fromSeq !== undefined && range.fromSeq > 1) {
      const anchorSeq = range.fromSeq - 1;
      anchorEvent = events.find((e) => e.seq === anchorSeq);
      events = events.filter((e) => e.seq !== anchorSeq);
    }
    return verifyEvents(events, {
      stream,
      keys,
      checkpoints,
      ...(head ? { head } : {}),
      range,
      ...(anchorEvent ? { anchorEvent } : {}),
      ...(read.issues ? { extraIssues: read.issues } : {}),
    });
  }

  const logger: AuditLogger = {
    redactor,
    store,
    record,
    recordSecurityEvent: (input) => record({ ...input, category: 'security' }),
    async query(q = {}) {
      return requireStore('query').query(normaliseQuery(q));
    },
    async count(f = {}) {
      return requireStore('count').count(normaliseFilter(f));
    },
    async getEvent(id) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 256) return undefined;
      return requireStore('getEvent').getById(id);
    },
    async listStreams() {
      return requireStore('listStreams').listStreams();
    },
    verifyChain,
    async verifyAll() {
      const streams = await requireStore('verifyAll').listStreams();
      const out: ChainVerificationReport[] = [];
      for (const st of streams) out.push(await verifyChain(st));
      return out;
    },
    async createCheckpoint(stream) {
      const s = requireStore('createCheckpoint');
      const head = await s.getHead(stream);
      if (!head) throw new AuditError('AUDIT_NOT_FOUND', `stream ${stream} has no events`);
      const cp = seal({
        id: generateId(),
        stream,
        kind: 'manual',
        seq: head.seq,
        hash: head.hash,
        createdAt: clock.now(),
      });
      await s.saveCheckpoint(cp);
      return cp;
    },
    async applyRetention(opts = {}) {
      const s = requireStore('applyRetention');
      const now = opts.now ?? clock.now();
      const dryRun = opts.dryRun ?? false;
      const cutoffs = {} as Record<AuditCategory, number>;
      for (const c of AUDIT_CATEGORIES) cutoffs[c] = now - retentionByCategory[c] * DAY;
      const streams: StreamPurgeResult[] = [];
      for (const st of await s.listStreams()) {
        streams.push(await s.purge(st, { cutoffs, dryRun, seal, generateId, now }));
      }
      return {
        dryRun,
        cutoffs,
        streams,
        purged: streams.reduce((n, r) => n + r.purged, 0),
        expiredRetained: streams.reduce((n, r) => n + r.expiredRetained, 0),
      };
    },
    async flush() {
      await Promise.all(sinks.map((s) => s.flush?.()));
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(sinks.map((s) => s.flush?.()));
      await Promise.all(sinks.map((s) => s.close?.()));
    },
  };
  return logger;
}
