import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { canonicalJson, digestsEqual, hmacSha256Hex, sha256Hex } from './canonical.js';
import { AuditError } from './errors.js';
import type {
  AuditCheckpoint,
  AuditEvent,
  ChainHead,
  ChainIssue,
  ChainVerificationReport,
  HashAlgorithm,
  VerifyRange,
} from './types.js';

/** prevHash of the first event of a stream. */
export const GENESIS_HASH = '0'.repeat(64);

export type KeyInput = string | Uint8Array;

export interface ChainOptions {
  /**
   * HMAC key (at least 32 bytes; strings are used as UTF-8). With a key, an attacker who can
   * write to the database cannot recompute a valid chain.
   */
  hmacKey?: KeyInput;
  /** Identifier stored with each event so keys can rotate. Default `k1`. */
  hmacKeyId?: string;
  /** Retired keys still accepted for verification, by key ID. */
  previousHmacKeys?: Readonly<Record<string, KeyInput>>;
  /** Accept events hashed without a key even though a key is configured. Default false. */
  allowUnkeyedEvents?: boolean;
  /** Ed25519 private key (KeyObject or PEM) used to sign checkpoints. */
  signingKey?: KeyObject | string;
  /** Ed25519 public key (KeyObject or PEM). Derived from signingKey when omitted. */
  verifyKey?: KeyObject | string;
}

export interface ResolvedChainKeys {
  hmacKey?: Buffer;
  hmacKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
  allowUnkeyedEvents: boolean;
  signingKey?: KeyObject;
  verifyKey?: KeyObject;
}

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

function toKey(name: string, input: KeyInput): Buffer {
  const buf =
    typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input as Uint8Array);
  if (buf.length < 32) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', `${name} must be at least 32 bytes`);
  }
  return buf;
}

function ed25519(key: KeyObject, name: string): KeyObject {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new AuditError('AUDIT_INVALID_OPTIONS', `${name} must be an Ed25519 key`);
  }
  return key;
}

/** Validates chain options and prepares key material. */
export function resolveChainKeys(options: ChainOptions = {}): ResolvedChainKeys {
  const hmacKeyId = options.hmacKeyId ?? 'k1';
  if (!KEY_ID.test(hmacKeyId)) {
    throw new AuditError(
      'AUDIT_INVALID_OPTIONS',
      'chain.hmacKeyId must match [A-Za-z0-9._-]{1,64}',
    );
  }
  const keys = new Map<string, Buffer>();
  for (const [id, k] of Object.entries(options.previousHmacKeys ?? {})) {
    if (!KEY_ID.test(id)) {
      throw new AuditError('AUDIT_INVALID_OPTIONS', `chain.previousHmacKeys has an invalid key ID`);
    }
    keys.set(id, toKey(`chain.previousHmacKeys.${id}`, k));
  }
  const out: ResolvedChainKeys = {
    hmacKeyId,
    keys,
    allowUnkeyedEvents: options.allowUnkeyedEvents ?? false,
  };
  if (options.hmacKey !== undefined) {
    const key = toKey('chain.hmacKey', options.hmacKey);
    keys.set(hmacKeyId, key);
    out.hmacKey = key;
  }
  if (options.signingKey !== undefined) {
    const sk =
      typeof options.signingKey === 'string'
        ? createPrivateKey(options.signingKey)
        : options.signingKey;
    if (sk.type !== 'private') {
      throw new AuditError('AUDIT_INVALID_OPTIONS', 'chain.signingKey must be a private key');
    }
    out.signingKey = ed25519(sk, 'chain.signingKey');
    out.verifyKey = createPublicKey(sk);
  }
  if (options.verifyKey !== undefined) {
    const vk =
      typeof options.verifyKey === 'string'
        ? createPublicKey(options.verifyKey)
        : options.verifyKey.type === 'private'
          ? createPublicKey(options.verifyKey)
          : options.verifyKey;
    out.verifyKey = ed25519(vk, 'chain.verifyKey');
  }
  return out;
}

function eventBody(event: Omit<AuditEvent, 'hash'> | AuditEvent): string {
  const { hash: _ignored, ...rest } = event as AuditEvent;
  return canonicalJson(rest);
}

/** Algorithm and key ID for new events. */
export function hashParams(keys: ResolvedChainKeys): { hashAlg: HashAlgorithm; keyId?: string } {
  return keys.hmacKey ? { hashAlg: 'hmac-sha256', keyId: keys.hmacKeyId } : { hashAlg: 'sha256' };
}

/** Computes the hash of an event (every field except `hash`) using its hashAlg and keyId. */
export function computeEventHash(
  event: Omit<AuditEvent, 'hash'> | AuditEvent,
  keys: ResolvedChainKeys,
): string {
  const body = eventBody(event);
  if (event.hashAlg === 'hmac-sha256') {
    const key = event.keyId === undefined ? undefined : keys.keys.get(event.keyId);
    if (!key) {
      throw new AuditError(
        'AUDIT_CHAIN_KEY_REQUIRED',
        `HMAC key ${event.keyId ?? '(none)'} is required to verify this stream`,
      );
    }
    return hmacSha256Hex(key, body);
  }
  return sha256Hex(body);
}

function checkpointBody(cp: AuditCheckpoint): string {
  const { mac: _m, signature: _s, signatureAlg: _a, ...body } = cp;
  return canonicalJson(body);
}

/** Adds an HMAC and an Ed25519 signature to a checkpoint when keys are configured. */
export function sealCheckpoint(
  body: Omit<AuditCheckpoint, 'mac' | 'signature' | 'signatureAlg' | 'keyId'>,
  keys: ResolvedChainKeys,
): AuditCheckpoint {
  const cp: AuditCheckpoint = { ...body };
  if (keys.hmacKey) cp.keyId = keys.hmacKeyId;
  const data = checkpointBody(cp);
  if (keys.hmacKey) cp.mac = hmacSha256Hex(keys.hmacKey, data);
  if (keys.signingKey) {
    cp.signature = cryptoSign(null, Buffer.from(data, 'utf8'), keys.signingKey).toString('base64');
    cp.signatureAlg = 'ed25519';
  }
  return cp;
}

/** Returns a problem description when a checkpoint fails authentication, otherwise undefined. */
export function checkCheckpoint(cp: AuditCheckpoint, keys: ResolvedChainKeys): string | undefined {
  const data = checkpointBody(cp);
  if (cp.mac !== undefined || keys.hmacKey) {
    if (cp.mac === undefined) return 'checkpoint has no MAC but an HMAC key is configured';
    const key = cp.keyId === undefined ? undefined : keys.keys.get(cp.keyId);
    if (!key) {
      throw new AuditError(
        'AUDIT_CHAIN_KEY_REQUIRED',
        `HMAC key ${cp.keyId ?? '(none)'} is required to verify checkpoint ${cp.id}`,
      );
    }
    if (!digestsEqual(cp.mac, hmacSha256Hex(key, data))) return 'checkpoint MAC does not match';
  }
  if (keys.verifyKey) {
    if (cp.signature === undefined)
      return 'checkpoint is not signed but a verify key is configured';
    let valid = false;
    try {
      valid = cryptoVerify(
        null,
        Buffer.from(data, 'utf8'),
        keys.verifyKey,
        Buffer.from(cp.signature, 'base64'),
      );
    } catch {
      valid = false;
    }
    if (!valid) return 'checkpoint signature is invalid';
  }
  return undefined;
}

export interface VerifyEventsOptions {
  stream: string;
  keys: ResolvedChainKeys;
  checkpoints?: readonly AuditCheckpoint[];
  /** Head recorded by the store; enables detection of tail deletion. */
  head?: ChainHead;
  range?: VerifyRange;
  /** Event at range.fromSeq - 1, used as the anchor of a partial verification. */
  anchorEvent?: AuditEvent;
  /**
   * Accept the first event's prevHash without an anchor (for example a rotated JSON Lines
   * file whose older files were deleted). Default false.
   */
  unanchored?: boolean;
  /** Issues found by the store itself (for example indexed columns that disagree with the record). */
  extraIssues?: readonly ChainIssue[];
}

/**
 * Verifies a list of events of one stream in storage order and reports modification,
 * deletion, insertion, reordering, truncation and checkpoint problems precisely.
 */
export function verifyEvents(
  events: readonly AuditEvent[],
  options: VerifyEventsOptions,
): ChainVerificationReport {
  const { stream, keys } = options;
  const range = options.range ?? {};
  const issues: ChainIssue[] = [...(options.extraIssues ?? [])];

  // Checkpoints.
  const purgeCps: AuditCheckpoint[] = [];
  const attestCps: AuditCheckpoint[] = [];
  for (const cp of options.checkpoints ?? []) {
    if (cp.stream !== stream) continue;
    const problem = checkCheckpoint(cp, keys);
    if (problem) {
      issues.push({
        kind: 'checkpoint-invalid',
        seq: cp.seq,
        checkpointId: cp.id,
        message: problem,
      });
      continue;
    }
    if (cp.kind === 'manual') attestCps.push(cp);
    else purgeCps.push(cp);
  }
  purgeCps.sort((a, b) => a.seq - b.seq);
  const anchorCp = purgeCps[purgeCps.length - 1];

  // Per-event hash validity and storage order.
  const valid = new Map<AuditEvent, boolean>();
  let maxSeq = Number.NEGATIVE_INFINITY;
  const bySeq = new Map<number, AuditEvent[]>();
  for (const e of events) {
    let ok: boolean;
    let reason = 'content does not match its hash';
    if (keys.hmacKey && e.hashAlg !== 'hmac-sha256' && !keys.allowUnkeyedEvents) {
      ok = false;
      reason = 'event is not HMAC-protected although an HMAC key is configured (downgrade)';
    } else {
      ok = typeof e.hash === 'string' && digestsEqual(e.hash, computeEventHash(e, keys));
    }
    valid.set(e, ok);
    if (!ok) issues.push({ kind: 'modified', seq: e.seq, eventId: e.id, message: reason });
    if (!Number.isSafeInteger(e.seq) || e.seq < 1) {
      issues.push({
        kind: 'inserted',
        eventId: e.id,
        message: 'event has no valid sequence number',
      });
      continue;
    }
    const group = bySeq.get(e.seq);
    if (group) group.push(e);
    else bySeq.set(e.seq, [e]);
    if (e.seq < maxSeq && !group) {
      issues.push({
        kind: 'reordered',
        seq: e.seq,
        eventId: e.id,
        message: `event ${e.seq} is stored after event ${maxSeq}`,
      });
    }
    if (e.seq > maxSeq) maxSeq = e.seq;
  }

  // Duplicates: keep the first valid event per sequence number, the others are insertions.
  const chain: AuditEvent[] = [];
  for (const seq of [...bySeq.keys()].sort((a, b) => a - b)) {
    const group = bySeq.get(seq) ?? [];
    const keep = group.find((e) => valid.get(e)) ?? group[0];
    if (!keep) continue;
    chain.push(keep);
    for (const e of group) {
      if (e !== keep) {
        issues.push({
          kind: 'inserted',
          seq,
          eventId: e.id,
          message: `a second event claims sequence number ${seq}`,
        });
      }
    }
  }

  // Anchor.
  let anchor: ChainVerificationReport['anchor'];
  const from = range.fromSeq;
  if (from !== undefined && from > 1 && !(anchorCp && anchorCp.seq >= from - 1)) {
    const ae = options.anchorEvent;
    if (ae && ae.seq === from - 1) {
      anchor = { kind: 'event', seq: ae.seq, hash: ae.hash };
      if (!digestsEqual(ae.hash, computeEventHash(ae, keys))) {
        issues.push({
          kind: 'modified',
          seq: ae.seq,
          eventId: ae.id,
          message: 'anchor event content does not match its hash',
        });
      }
    } else {
      anchor = { kind: 'unanchored', seq: from - 1 };
    }
  } else if (anchorCp) {
    anchor = {
      kind: 'checkpoint',
      seq: anchorCp.seq,
      hash: anchorCp.hash,
      checkpointId: anchorCp.id,
    };
  } else if (options.unanchored && chain.length > 0) {
    const first = chain[0] as AuditEvent;
    anchor = { kind: 'unanchored', seq: first.seq - 1, hash: first.prevHash };
  } else {
    anchor = { kind: 'genesis', seq: 0, hash: GENESIS_HASH };
  }

  const inRange = chain.filter(
    (e) =>
      e.seq > anchor.seq &&
      (from === undefined || e.seq >= from) &&
      (range.toSeq === undefined || e.seq <= range.toSeq),
  );

  // Links and gaps.
  let prevSeq = anchor.seq;
  let prevHash = anchor.hash;
  let prevValid = true;
  for (const e of inRange) {
    const ok = valid.get(e) === true;
    if (e.seq > prevSeq + 1) {
      issues.push({
        kind: 'deleted',
        seq: prevSeq + 1,
        toSeq: e.seq - 1,
        message:
          e.seq - 1 === prevSeq + 1
            ? `event ${prevSeq + 1} is missing`
            : `events ${prevSeq + 1} to ${e.seq - 1} are missing`,
      });
    } else if (prevHash !== undefined && !digestsEqual(e.prevHash, prevHash) && ok && prevValid) {
      issues.push({
        kind: 'broken-link',
        seq: e.seq,
        eventId: e.id,
        message:
          prevSeq === anchor.seq && anchor.kind === 'checkpoint'
            ? `event ${e.seq} does not link to the checkpoint that anchors the stream`
            : `event ${e.seq} does not link to event ${prevSeq} (event ${prevSeq} was replaced or event ${e.seq} was forged)`,
      });
    }
    prevSeq = e.seq;
    prevHash = e.hash;
    prevValid = ok;
  }

  // Tail.
  const head = options.head;
  const last = inRange[inRange.length - 1];
  const lastSeq = last ? last.seq : anchor.seq;
  if (range.toSeq !== undefined) {
    const limit = head ? Math.min(range.toSeq, head.seq) : range.toSeq;
    if (lastSeq < limit && head) {
      issues.push({
        kind: 'deleted',
        seq: lastSeq + 1,
        toSeq: limit,
        message: `events ${lastSeq + 1} to ${limit} are missing`,
      });
    }
  } else if (head) {
    if (lastSeq < head.seq) {
      issues.push({
        kind: 'truncated',
        seq: lastSeq + 1,
        toSeq: head.seq,
        message: `the stream head is at ${head.seq} but events after ${lastSeq} are missing`,
      });
    } else if (last && last.seq === head.seq && !digestsEqual(last.hash, head.hash)) {
      issues.push({
        kind: 'head-mismatch',
        seq: last.seq,
        eventId: last.id,
        message: 'the last event does not match the recorded stream head',
      });
    }
    for (const e of inRange) {
      if (e.seq > head.seq) {
        issues.push({
          kind: 'inserted',
          seq: e.seq,
          eventId: e.id,
          message: `event ${e.seq} is beyond the recorded stream head ${head.seq}`,
        });
      }
    }
  }

  // Attestation checkpoints.
  const seqIndex = new Map(chain.map((e) => [e.seq, e]));
  for (const cp of attestCps) {
    if (cp.seq <= anchor.seq) continue;
    if (from !== undefined && cp.seq < from) continue;
    if (range.toSeq !== undefined && cp.seq > range.toSeq) continue;
    const e = seqIndex.get(cp.seq);
    if (!e) {
      issues.push({
        kind: 'checkpoint-mismatch',
        seq: cp.seq,
        checkpointId: cp.id,
        message: `checkpoint attests event ${cp.seq}, which is missing`,
      });
    } else if (!digestsEqual(e.hash, cp.hash)) {
      issues.push({
        kind: 'checkpoint-mismatch',
        seq: cp.seq,
        checkpointId: cp.id,
        eventId: e.id,
        message: `event ${cp.seq} differs from the version attested by checkpoint ${cp.id}`,
      });
    }
  }

  issues.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const report: ChainVerificationReport = {
    stream,
    ok: issues.length === 0,
    checked: events.length,
    anchor,
    issues,
  };
  const first = inRange[0];
  if (first) report.firstSeq = first.seq;
  if (last) report.lastSeq = last.seq;
  if (head) report.head = { seq: head.seq, hash: head.hash };
  return report;
}
