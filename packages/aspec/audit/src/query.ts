import { AuditError } from './errors.js';
import {
  AUDIT_CATEGORIES,
  AUDIT_OUTCOMES,
  type AuditCategory,
  type AuditEvent,
  type AuditOutcome,
} from './types.js';

export interface AuditFilter {
  actorId?: string;
  actorType?: string;
  /** Exact action. */
  action?: string;
  /** Action prefix, for example `auth.` or `auth.login`. */
  actionPrefix?: string;
  resourceType?: string;
  resourceId?: string;
  tenantId?: string;
  outcome?: AuditOutcome;
  category?: AuditCategory;
  requestId?: string;
  correlationId?: string;
  stream?: string;
  /** Inclusive lower bound (epoch ms or Date). */
  from?: number | Date;
  /** Exclusive upper bound (epoch ms or Date). */
  to?: number | Date;
}

export interface AuditQuery extends AuditFilter {
  /** Default `desc` (newest first). */
  order?: 'asc' | 'desc';
  /** Default 50, maximum 1000. */
  limit?: number;
  /** Opaque cursor from a previous result. */
  cursor?: string;
}

export interface AuditQueryResult {
  events: AuditEvent[];
  /** Present when more events match. */
  nextCursor?: string;
}

export interface NormalisedFilter {
  actorId?: string;
  actorType?: string;
  action?: string;
  actionPrefix?: string;
  resourceType?: string;
  resourceId?: string;
  tenantId?: string;
  outcome?: AuditOutcome;
  category?: AuditCategory;
  requestId?: string;
  correlationId?: string;
  stream?: string;
  from?: number;
  to?: number;
}

export interface NormalisedQuery {
  filter: NormalisedFilter;
  order: 'asc' | 'desc';
  limit: number;
  after?: { timestamp: number; id: string };
}

export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 1000;

const STRING_FIELDS = [
  'actorId',
  'actorType',
  'action',
  'actionPrefix',
  'resourceType',
  'resourceId',
  'tenantId',
  'requestId',
  'correlationId',
  'stream',
] as const;

function toMs(name: string, v: number | Date | undefined): number | undefined {
  if (v === undefined) return undefined;
  const ms = v instanceof Date ? v.getTime() : v;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new AuditError('AUDIT_INVALID_QUERY', `${name} must be a valid time`);
  }
  return ms;
}

export function normaliseFilter(f: AuditFilter = {}): NormalisedFilter {
  const out: NormalisedFilter = {};
  for (const key of STRING_FIELDS) {
    const v = f[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length === 0 || v.length > 512) {
      throw new AuditError(
        'AUDIT_INVALID_QUERY',
        `${key} must be a non-empty string of at most 512 characters`,
      );
    }
    out[key] = v;
  }
  if (f.outcome !== undefined) {
    if (!AUDIT_OUTCOMES.includes(f.outcome)) {
      throw new AuditError(
        'AUDIT_INVALID_QUERY',
        `outcome must be one of ${AUDIT_OUTCOMES.join(', ')}`,
      );
    }
    out.outcome = f.outcome;
  }
  if (f.category !== undefined) {
    if (!AUDIT_CATEGORIES.includes(f.category)) {
      throw new AuditError(
        'AUDIT_INVALID_QUERY',
        `category must be one of ${AUDIT_CATEGORIES.join(', ')}`,
      );
    }
    out.category = f.category;
  }
  const from = toMs('from', f.from);
  const to = toMs('to', f.to);
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  return out;
}

interface CursorPayload {
  v: 1;
  o: 'asc' | 'desc';
  t: number;
  i: string;
}

export function encodeCursor(
  order: 'asc' | 'desc',
  event: Pick<AuditEvent, 'timestamp' | 'id'>,
): string {
  const payload: CursorPayload = { v: 1, o: order, t: event.timestamp, i: event.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(
  cursor: string,
  order: 'asc' | 'desc',
): { timestamp: number; id: string } {
  let payload: unknown;
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('format');
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AuditError('AUDIT_INVALID_CURSOR', 'cursor is malformed');
  }
  const p = payload as Partial<CursorPayload>;
  if (
    p === null ||
    typeof p !== 'object' ||
    p.v !== 1 ||
    typeof p.t !== 'number' ||
    !Number.isFinite(p.t) ||
    typeof p.i !== 'string' ||
    p.i.length > 256
  ) {
    throw new AuditError('AUDIT_INVALID_CURSOR', 'cursor is malformed');
  }
  if (p.o !== order) {
    throw new AuditError('AUDIT_INVALID_CURSOR', 'cursor was created for a different order');
  }
  return { timestamp: p.t, id: p.i };
}

export function normaliseQuery(q: AuditQuery = {}): NormalisedQuery {
  const order = q.order ?? 'desc';
  if (order !== 'asc' && order !== 'desc') {
    throw new AuditError('AUDIT_INVALID_QUERY', 'order must be asc or desc');
  }
  const limit = q.limit ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new AuditError(
      'AUDIT_INVALID_QUERY',
      `limit must be an integer from 1 to ${MAX_QUERY_LIMIT}`,
    );
  }
  const out: NormalisedQuery = { filter: normaliseFilter(q), order, limit };
  if (q.cursor !== undefined) out.after = decodeCursor(q.cursor, order);
  return out;
}

/** Orders events by timestamp, then ID. */
export function compareEvents(
  a: Pick<AuditEvent, 'timestamp' | 'id'>,
  b: Pick<AuditEvent, 'timestamp' | 'id'>,
): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function matchesFilter(e: AuditEvent, f: NormalisedFilter): boolean {
  if (f.actorId !== undefined && e.actor?.id !== f.actorId) return false;
  if (f.actorType !== undefined && e.actor?.type !== f.actorType) return false;
  if (f.action !== undefined && e.action !== f.action) return false;
  if (f.actionPrefix !== undefined && !e.action.startsWith(f.actionPrefix)) return false;
  if (f.resourceType !== undefined && e.resource?.type !== f.resourceType) return false;
  if (f.resourceId !== undefined && e.resource?.id !== f.resourceId) return false;
  if (f.tenantId !== undefined && e.tenantId !== f.tenantId) return false;
  if (f.outcome !== undefined && e.outcome !== f.outcome) return false;
  if (f.category !== undefined && e.category !== f.category) return false;
  if (f.requestId !== undefined && e.requestId !== f.requestId) return false;
  if (f.correlationId !== undefined && e.correlationId !== f.correlationId) return false;
  if (f.stream !== undefined && e.stream !== f.stream) return false;
  if (f.from !== undefined && e.timestamp < f.from) return false;
  if (f.to !== undefined && e.timestamp >= f.to) return false;
  return true;
}
