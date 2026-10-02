import type { FieldChange } from './diff.js';
import type { AuditEventInput } from './ports.js';

export type AuditOutcome = 'success' | 'failure' | 'denied';
export type AuditCategory = 'security' | 'data' | 'admin' | 'system';

export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['success', 'failure', 'denied'];
export const AUDIT_CATEGORIES: readonly AuditCategory[] = ['security', 'data', 'admin', 'system'];

export interface AuditActor {
  id: string;
  type?: string;
  ip?: string;
  userAgent?: string;
}

export interface AuditResource {
  type: string;
  id?: string;
}

export interface AuditChanges {
  before?: unknown;
  after?: unknown;
  /** Field-level differences computed from before and after (values redacted). */
  diff: FieldChange[];
  /** Present when the diff was cut at the configured maximum number of entries. */
  diffTruncated?: true;
}

export type HashAlgorithm = 'sha256' | 'hmac-sha256';

/** A stored, normalised, redacted and hash-chained audit event. */
export interface AuditEvent {
  /** UUID version 7 (time-ordered). */
  id: string;
  /** Hash chain the event belongs to. */
  stream: string;
  /** Position in the stream, starting at 1. */
  seq: number;
  /** Epoch milliseconds. */
  timestamp: number;
  /** ISO 8601 form of timestamp. */
  time: string;
  action: string;
  outcome: AuditOutcome;
  category: AuditCategory;
  /** True for security events (category `security`). */
  security: boolean;
  actor?: AuditActor;
  resource?: AuditResource;
  tenantId?: string;
  requestId?: string;
  correlationId?: string;
  changes?: AuditChanges;
  metadata?: Record<string, unknown>;
  /** Hash of the previous event in the stream (64 zeros for the first event). */
  prevHash: string;
  /** SHA-256 or HMAC-SHA-256 (hex) over the canonical JSON of every other field. */
  hash: string;
  hashAlg: HashAlgorithm;
  /** HMAC key identifier when hashAlg is hmac-sha256. */
  keyId?: string;
}

/** Input accepted by `record()`: the AuditSink port input plus an explicit correlation ID. */
export interface AuditRecordInput extends AuditEventInput {
  correlationId?: string;
}

/** Head of a stream: the last appended event. */
export interface ChainHead {
  stream: string;
  seq: number;
  hash: string;
}

export type CheckpointKind = 'retention' | 'eviction' | 'manual';

/**
 * A checkpoint anchors a stream. Retention and eviction checkpoints record the last purged
 * event so verification of the remaining events stays possible; manual checkpoints attest the
 * head at a point in time.
 */
export interface AuditCheckpoint {
  id: string;
  stream: string;
  kind: CheckpointKind;
  seq: number;
  hash: string;
  createdAt: number;
  purgedCount?: number;
  /** HMAC-SHA-256 over the canonical checkpoint body when an HMAC key is configured. */
  mac?: string;
  keyId?: string;
  /** Ed25519 signature (base64) when a signing key is configured. */
  signature?: string;
  signatureAlg?: 'ed25519';
}

export type ChainIssueKind =
  | 'modified'
  | 'deleted'
  | 'inserted'
  | 'reordered'
  | 'broken-link'
  | 'truncated'
  | 'head-mismatch'
  | 'checkpoint-invalid'
  | 'checkpoint-mismatch';

export interface ChainIssue {
  kind: ChainIssueKind;
  /** Sequence number concerned (first of a range for deleted and truncated). */
  seq?: number;
  /** Last sequence number of a missing range. */
  toSeq?: number;
  eventId?: string;
  checkpointId?: string;
  message: string;
}

export interface ChainVerificationReport {
  stream: string;
  ok: boolean;
  /** Number of events examined. */
  checked: number;
  firstSeq?: number;
  lastSeq?: number;
  anchor: {
    kind: 'genesis' | 'checkpoint' | 'event' | 'unanchored';
    seq: number;
    hash?: string;
    checkpointId?: string;
  };
  head?: { seq: number; hash: string };
  issues: ChainIssue[];
}

export interface VerifyRange {
  fromSeq?: number;
  toSeq?: number;
}
