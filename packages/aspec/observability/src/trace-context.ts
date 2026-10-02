import { randomBytes } from 'node:crypto';

/** Parsed W3C `traceparent` header (Trace Context Level 1 and 2). */
export interface TraceParent {
  version: string;
  traceId: string;
  /** The `parent-id` field: the span ID of the caller. */
  parentId: string;
  /** Trace flags as a number (bit 0 is `sampled`). */
  traceFlags: number;
  sampled: boolean;
}

export interface TraceStateEntry {
  key: string;
  value: string;
}

const HEX_TRACE_ID = /^[0-9a-f]{32}$/;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/;
const HEX_BYTE = /^[0-9a-f]{2}$/;
const ZERO_TRACE_ID = '00000000000000000000000000000000';
const ZERO_SPAN_ID = '0000000000000000';

/** Maximum accepted `traceparent` length. Future versions may append fields; bound the input. */
const MAX_TRACEPARENT_LENGTH = 512;
const MAX_TRACESTATE_LENGTH = 512;
const MAX_TRACESTATE_MEMBERS = 32;

export function isValidTraceId(value: string): boolean {
  return HEX_TRACE_ID.test(value) && value !== ZERO_TRACE_ID;
}

export function isValidSpanId(value: string): boolean {
  return HEX_SPAN_ID.test(value) && value !== ZERO_SPAN_ID;
}

/**
 * Parses a `traceparent` header. Returns undefined for anything that does not conform to the
 * W3C Trace Context specification (wrong lengths, uppercase hex, all-zero IDs, version ff,
 * extra fields on version 00).
 */
export function parseTraceparent(header: string | null | undefined): TraceParent | undefined {
  if (typeof header !== 'string') return undefined;
  const value = header.trim();
  if (value.length < 55 || value.length > MAX_TRACEPARENT_LENGTH) return undefined;
  const version = value.slice(0, 2);
  if (!HEX_BYTE.test(version) || version === 'ff') return undefined;
  if (version === '00' && value.length !== 55) return undefined;
  if (value.length > 55 && value[55] !== '-') return undefined;
  if (value[2] !== '-' || value[35] !== '-' || value[52] !== '-') return undefined;
  const traceId = value.slice(3, 35);
  const parentId = value.slice(36, 52);
  const flags = value.slice(53, 55);
  if (!isValidTraceId(traceId) || !isValidSpanId(parentId) || !HEX_BYTE.test(flags)) {
    return undefined;
  }
  const traceFlags = Number.parseInt(flags, 16);
  return { version, traceId, parentId, traceFlags, sampled: (traceFlags & 1) === 1 };
}

export interface FormatTraceparentInput {
  traceId: string;
  spanId: string;
  traceFlags?: number;
}

/** Formats a version 00 `traceparent` header. Throws on invalid IDs. */
export function formatTraceparent(input: FormatTraceparentInput): string {
  if (!isValidTraceId(input.traceId)) throw new TypeError('traceId must be 32 lowercase hex');
  if (!isValidSpanId(input.spanId)) throw new TypeError('spanId must be 16 lowercase hex');
  const flags = (input.traceFlags ?? 0) & 0xff;
  return `00-${input.traceId}-${input.spanId}-${flags.toString(16).padStart(2, '0')}`;
}

const SIMPLE_KEY = /^[a-z][a-z0-9_\-*/]{0,255}$/;
const MULTI_TENANT_KEY = /^[a-z0-9][a-z0-9_\-*/]{0,240}@[a-z][a-z0-9_\-*/]{0,13}$/;
// chr = %x20 / nblk-chr, nblk-chr = %x21-2B / %x2D-3C / %x3E-7E, the last character is nblk-chr.
const TRACESTATE_VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

/**
 * Parses a `tracestate` header into ordered entries. Invalid and duplicate members are
 * dropped (the first occurrence of a key wins) and at most 32 members are kept.
 */
export function parseTracestate(header: string | null | undefined): TraceStateEntry[] {
  if (typeof header !== 'string' || header.length === 0) return [];
  if (header.length > MAX_TRACESTATE_LENGTH * 2) return [];
  const out: TraceStateEntry[] = [];
  const seen = new Set<string>();
  for (const raw of header.split(',')) {
    const member = raw.trim();
    if (member.length === 0) continue;
    const eq = member.indexOf('=');
    if (eq <= 0) continue;
    const key = member.slice(0, eq);
    const value = member.slice(eq + 1);
    if (!SIMPLE_KEY.test(key) && !MULTI_TENANT_KEY.test(key)) continue;
    if (!TRACESTATE_VALUE.test(value)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, value });
    if (out.length >= MAX_TRACESTATE_MEMBERS) break;
  }
  return out;
}

/** Serialises tracestate entries, dropping trailing entries beyond 512 characters. */
export function formatTracestate(entries: readonly TraceStateEntry[]): string {
  let out = '';
  for (const entry of entries.slice(0, MAX_TRACESTATE_MEMBERS)) {
    const member = `${entry.key}=${entry.value}`;
    const next = out.length === 0 ? member : `${out},${member}`;
    if (next.length > MAX_TRACESTATE_LENGTH) break;
    out = next;
  }
  return out;
}

/** Generates a random 16-byte trace ID (32 lowercase hex characters). */
export function generateTraceId(): string {
  let id = randomBytes(16).toString('hex');
  while (id === ZERO_TRACE_ID) id = randomBytes(16).toString('hex');
  return id;
}

/** Generates a random 8-byte span ID (16 lowercase hex characters). */
export function generateSpanId(): string {
  let id = randomBytes(8).toString('hex');
  while (id === ZERO_SPAN_ID) id = randomBytes(8).toString('hex');
  return id;
}
