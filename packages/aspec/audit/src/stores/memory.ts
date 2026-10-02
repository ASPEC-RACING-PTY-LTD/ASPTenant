import { AuditError } from '../errors.js';
import {
  type AuditQueryResult,
  compareEvents,
  encodeCursor,
  matchesFilter,
  type NormalisedFilter,
  type NormalisedQuery,
} from '../query.js';
import {
  type AuditStore,
  isExpired,
  type PurgeOptions,
  type ReadStreamResult,
  type StoreAttachContext,
  type StreamPurgeResult,
} from '../store.js';
import type { AuditCheckpoint, AuditEvent, ChainHead, VerifyRange } from '../types.js';

export interface MemoryAuditStoreOptions {
  /**
   * Maximum number of events kept. The oldest events are evicted first and an eviction
   * checkpoint keeps the remaining chain verifiable. Default 10000.
   */
  maxEvents?: number;
  /** Maximum manual checkpoints kept per stream. Default 1000. */
  maxCheckpointsPerStream?: number;
}

export interface MemoryAuditStore extends AuditStore {
  /** Number of events currently held. */
  size(): number;
  /** Removes every event, head and checkpoint. */
  clear(): void;
  /** Events in insertion order (a copy). Useful in tests. */
  all(): AuditEvent[];
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** Bounded in-memory store for tests, development and single-process applications. */
export function createMemoryAuditStore(options: MemoryAuditStoreOptions = {}): MemoryAuditStore {
  const maxEvents = options.maxEvents ?? 10000;
  const maxCheckpoints = options.maxCheckpointsPerStream ?? 1000;
  if (!Number.isInteger(maxEvents) || maxEvents < 1) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'maxEvents must be a positive integer');
  }
  if (!Number.isInteger(maxCheckpoints) || maxCheckpoints < 1) {
    throw new AuditError(
      'AUDIT_INVALID_OPTIONS',
      'maxCheckpointsPerStream must be a positive integer',
    );
  }
  let events: AuditEvent[] = [];
  const byId = new Map<string, AuditEvent>();
  const heads = new Map<string, ChainHead>();
  const checkpoints = new Map<string, AuditCheckpoint[]>();
  let ctx: StoreAttachContext | undefined;

  function pushCheckpoint(cp: AuditCheckpoint): void {
    const list = checkpoints.get(cp.stream) ?? [];
    if (cp.kind !== 'manual') {
      // Only the latest purge checkpoint anchors the stream.
      const kept = list.filter((c) => c.kind === 'manual');
      kept.push(cp);
      checkpoints.set(cp.stream, kept);
      return;
    }
    list.push(cp);
    const manual = list.filter((c) => c.kind === 'manual');
    if (manual.length > maxCheckpoints) {
      const drop = manual[0];
      checkpoints.set(
        cp.stream,
        list.filter((c) => c !== drop),
      );
    } else {
      checkpoints.set(cp.stream, list);
    }
  }

  function evictIfNeeded(): void {
    if (events.length <= maxEvents) return;
    const excess = events.length - maxEvents;
    const evicted = events.slice(0, excess);
    events = events.slice(excess);
    const lastByStream = new Map<string, { event: AuditEvent; count: number }>();
    for (const e of evicted) {
      byId.delete(e.id);
      const cur = lastByStream.get(e.stream);
      lastByStream.set(e.stream, { event: e, count: (cur?.count ?? 0) + 1 });
    }
    for (const [stream, { event, count }] of lastByStream) {
      const previous = (checkpoints.get(stream) ?? []).find((c) => c.kind !== 'manual');
      const body = {
        id: ctx?.generateId() ?? event.id,
        stream,
        kind: 'eviction' as const,
        seq: event.seq,
        hash: event.hash,
        createdAt: ctx?.now() ?? Date.now(),
        purgedCount: (previous?.purgedCount ?? 0) + count,
      };
      pushCheckpoint(ctx ? ctx.sealCheckpoint(body) : body);
    }
  }

  function insert(e: AuditEvent): void {
    if (byId.has(e.id)) {
      throw new AuditError('AUDIT_CHAIN_CONFLICT', `event ${e.id} already exists`);
    }
    const stored = clone(e);
    events.push(stored);
    byId.set(e.id, stored);
    const head = heads.get(e.stream);
    if (!head || e.seq > head.seq)
      heads.set(e.stream, { stream: e.stream, seq: e.seq, hash: e.hash });
    evictIfNeeded();
  }

  const store: MemoryAuditStore = {
    kind: 'audit-store',
    name: 'memory',
    attach(c) {
      ctx = c;
    },
    async write(batch) {
      for (const e of batch) insert(e);
    },
    async appendChained(stream, build) {
      const head = heads.get(stream);
      const event = build(head ? { ...head } : undefined);
      if (event.stream !== stream || event.seq !== (head?.seq ?? 0) + 1) {
        throw new AuditError(
          'AUDIT_CHAIN_CONFLICT',
          'built event does not continue the stream head',
        );
      }
      insert(event);
      return clone(event);
    },
    async query(q: NormalisedQuery): Promise<AuditQueryResult> {
      const dir = q.order === 'asc' ? 1 : -1;
      const matching = events
        .filter((e) => matchesFilter(e, q.filter))
        .filter((e) => !q.after || compareEvents(e, q.after) * dir > 0)
        .sort((a, b) => compareEvents(a, b) * dir);
      const page = matching.slice(0, q.limit).map(clone);
      const result: AuditQueryResult = { events: page };
      const last = page[page.length - 1];
      if (matching.length > q.limit && last) result.nextCursor = encodeCursor(q.order, last);
      return result;
    },
    async count(f: NormalisedFilter) {
      let n = 0;
      for (const e of events) if (matchesFilter(e, f)) n++;
      return n;
    },
    async getById(id) {
      const e = byId.get(id);
      return e ? clone(e) : undefined;
    },
    async listStreams() {
      return [...heads.keys()].sort();
    },
    async getHead(stream) {
      const h = heads.get(stream);
      return h ? { ...h } : undefined;
    },
    async readStream(stream: string, range: VerifyRange): Promise<ReadStreamResult> {
      return {
        events: events
          .filter(
            (e) =>
              e.stream === stream &&
              (range.fromSeq === undefined || e.seq >= range.fromSeq) &&
              (range.toSeq === undefined || e.seq <= range.toSeq),
          )
          .map(clone),
      };
    },
    async listCheckpoints(stream) {
      return (checkpoints.get(stream) ?? []).map(clone);
    },
    async saveCheckpoint(cp) {
      pushCheckpoint(clone(cp));
    },
    async purge(stream: string, opts: PurgeOptions): Promise<StreamPurgeResult> {
      const own = events.filter((e) => e.stream === stream).sort((a, b) => a.seq - b.seq);
      let cut = 0;
      while (cut < own.length && isExpired(own[cut] as AuditEvent, opts.cutoffs)) cut++;
      const expiredRetained = own.slice(cut).filter((e) => isExpired(e, opts.cutoffs)).length;
      const result: StreamPurgeResult = { stream, purged: cut, expiredRetained };
      if (cut === 0) return result;
      const last = own[cut - 1] as AuditEvent;
      result.throughSeq = last.seq;
      if (opts.dryRun) return result;
      const doomed = new Set(own.slice(0, cut));
      events = events.filter((e) => !doomed.has(e));
      for (const e of doomed) byId.delete(e.id);
      const previous = (checkpoints.get(stream) ?? []).find((c) => c.kind !== 'manual');
      const cp = opts.seal({
        id: opts.generateId(),
        stream,
        kind: 'retention',
        seq: last.seq,
        hash: last.hash,
        createdAt: opts.now,
        purgedCount: (previous?.purgedCount ?? 0) + cut,
      });
      pushCheckpoint(cp);
      result.checkpoint = clone(cp);
      return result;
    },
    size: () => events.length,
    clear() {
      events = [];
      byId.clear();
      heads.clear();
      checkpoints.clear();
    },
    all: () => events.map(clone),
  };
  return store;
}
