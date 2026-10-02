import type { AuditQueryResult, NormalisedFilter, NormalisedQuery } from './query.js';
import type {
  AuditCategory,
  AuditCheckpoint,
  AuditEvent,
  ChainHead,
  ChainIssue,
  VerifyRange,
} from './types.js';

/** A write-only destination for finished (normalised, redacted, chained) events. */
export interface AuditEventSink {
  readonly name?: string;
  write(events: readonly AuditEvent[]): Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
  /** Last chain head per stream found in the sink, used to resume chains after a restart. */
  recoverHeads?(): Promise<ChainHead[]>;
}

export type CheckpointSealer = (
  body: Omit<AuditCheckpoint, 'mac' | 'signature' | 'signatureAlg' | 'keyId'>,
) => AuditCheckpoint;

export interface StoreAttachContext {
  sealCheckpoint: CheckpointSealer;
  generateId: () => string;
  now: () => number;
}

export interface PurgeOptions {
  /** Events of a category with a timestamp below its cutoff are expired. */
  cutoffs: Readonly<Record<AuditCategory, number>>;
  dryRun: boolean;
  seal: CheckpointSealer;
  generateId: () => string;
  now: number;
}

export interface StreamPurgeResult {
  stream: string;
  /** Number of events deleted (or that would be deleted in a dry run). */
  purged: number;
  /** Last deleted sequence number. */
  throughSeq?: number;
  checkpoint?: AuditCheckpoint;
  /**
   * Expired events kept because an unexpired event precedes them in the stream (only
   * possible when a custom streamOf mixes categories with different retention).
   */
  expiredRetained: number;
}

export interface ReadStreamResult {
  events: AuditEvent[];
  issues?: ChainIssue[];
}

/**
 * A queryable store that is also the chain authority: `appendChained` must serialise appends
 * per stream (in-process for memory, a row lock on the stream head for SQL).
 */
export interface AuditStore extends AuditEventSink {
  readonly kind: 'audit-store';
  attach?(ctx: StoreAttachContext): void;
  appendChained(
    stream: string,
    build: (head: ChainHead | undefined) => AuditEvent,
  ): Promise<AuditEvent>;
  query(query: NormalisedQuery): Promise<AuditQueryResult>;
  count(filter: NormalisedFilter): Promise<number>;
  getById(id: string): Promise<AuditEvent | undefined>;
  listStreams(): Promise<string[]>;
  getHead(stream: string): Promise<ChainHead | undefined>;
  /** Events of a stream in storage order. */
  readStream(stream: string, range: VerifyRange): Promise<ReadStreamResult>;
  listCheckpoints(stream: string): Promise<AuditCheckpoint[]>;
  saveCheckpoint(checkpoint: AuditCheckpoint): Promise<void>;
  /** Deletes the longest fully expired prefix of a stream and records a retention checkpoint. */
  purge(stream: string, options: PurgeOptions): Promise<StreamPurgeResult>;
}

export function isAuditStore(value: unknown): value is AuditStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'audit-store' &&
    typeof (value as { appendChained?: unknown }).appendChained === 'function'
  );
}

/** Whether an event is expired under the cutoffs. */
export function isExpired(
  e: Pick<AuditEvent, 'category' | 'timestamp'>,
  cutoffs: Readonly<Record<AuditCategory, number>>,
): boolean {
  return e.timestamp < cutoffs[e.category];
}
