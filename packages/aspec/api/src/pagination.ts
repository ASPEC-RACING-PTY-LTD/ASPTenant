import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestError } from '@aspec/errors';
import type { PaginationLinks, PaginationMeta } from './responses.js';

export interface OffsetPagination {
  kind: 'offset';
  offset: number;
  limit: number;
}

export interface CursorPagination {
  kind: 'cursor';
  cursor: string | undefined;
  limit: number;
  payload: CursorPayload | undefined;
}

export type Pagination = OffsetPagination | CursorPagination;

export interface CursorPayload {
  /** Opaque sort key / position. */
  p: unknown;
  /** Optional tie-breaker id. */
  i?: string;
}

export interface PaginationOptions {
  /** Default page size. Default 20. */
  defaultLimit?: number;
  /** Maximum page size. Default 100. */
  maxLimit?: number;
  /** Style: offset (default) or cursor. */
  style?: 'offset' | 'cursor';
  /**
   * HMAC secret for signed cursors. When set, cursors are `base64url(payload).base64url(sig)`.
   * Tampered cursors are rejected.
   */
  cursorSecret?: string | Uint8Array;
}

export interface PageInput {
  limit?: unknown;
  offset?: unknown;
  cursor?: unknown;
}

function asPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestError(`Invalid ${name}`, {
      code: 'API_INVALID_PAGINATION',
      details: { field: name },
    });
  }
  return n;
}

function secretBytes(secret: string | Uint8Array): Buffer {
  return typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
}

function sign(payloadB64: string, secret: string | Uint8Array): string {
  return createHmac('sha256', secretBytes(secret)).update(payloadB64).digest('base64url');
}

/** Encodes a cursor payload (optionally HMAC-signed). */
export function encodeCursor(payload: CursorPayload, secret?: string | Uint8Array): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  if (secret === undefined) return payloadB64;
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

/** Decodes a cursor; rejects tampering when a secret is configured. */
export function decodeCursor(cursor: string, secret?: string | Uint8Array): CursorPayload {
  try {
    if (secret !== undefined) {
      const dot = cursor.lastIndexOf('.');
      if (dot <= 0) {
        throw new BadRequestError('Invalid cursor', { code: 'API_INVALID_CURSOR' });
      }
      const payloadB64 = cursor.slice(0, dot);
      const sig = cursor.slice(dot + 1);
      const expected = sign(payloadB64, secret);
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new BadRequestError('Invalid cursor', { code: 'API_INVALID_CURSOR' });
      }
      return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as CursorPayload;
    }
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError('Invalid cursor', { code: 'API_INVALID_CURSOR', cause: err });
  }
}

/** Parses offset/limit or cursor pagination from query-like input. */
export function parsePagination(input: PageInput, options: PaginationOptions = {}): Pagination {
  const defaultLimit = options.defaultLimit ?? 20;
  const maxLimit = options.maxLimit ?? 100;
  let limit = asPositiveInt(input.limit, 'limit') ?? defaultLimit;
  if (limit < 1) limit = defaultLimit;
  if (limit > maxLimit) {
    throw new BadRequestError(`limit must be <= ${maxLimit}`, {
      code: 'API_INVALID_PAGINATION',
      details: { field: 'limit', maxLimit },
    });
  }
  const style = options.style ?? (input.cursor !== undefined ? 'cursor' : 'offset');
  if (style === 'cursor') {
    const raw =
      input.cursor === undefined || input.cursor === null || input.cursor === ''
        ? undefined
        : String(input.cursor);
    const payload = raw === undefined ? undefined : decodeCursor(raw, options.cursorSecret);
    return { kind: 'cursor', cursor: raw, limit, payload };
  }
  const offset = asPositiveInt(input.offset, 'offset') ?? 0;
  return { kind: 'offset', offset, limit };
}

export interface BuildPageOptions {
  baseUrl: string;
  /** Existing query string without leading `?`. */
  query?: URLSearchParams | Record<string, string>;
  total?: number;
  nextCursorPayload?: CursorPayload;
  prevCursorPayload?: CursorPayload;
  cursorSecret?: string | Uint8Array;
}

/** Builds meta and RFC 8288 links for a page of results. */
export function buildPageMeta(
  pagination: Pagination,
  itemCount: number,
  options: BuildPageOptions,
): { meta: PaginationMeta; links: PaginationLinks } {
  const params =
    options.query instanceof URLSearchParams
      ? new URLSearchParams(options.query)
      : new URLSearchParams(options.query ?? {});
  const hasMore =
    pagination.kind === 'offset'
      ? options.total !== undefined
        ? pagination.offset + itemCount < options.total
        : itemCount === pagination.limit
      : itemCount === pagination.limit && options.nextCursorPayload !== undefined;

  const href = (mutate: (p: URLSearchParams) => void): string => {
    const p = new URLSearchParams(params);
    mutate(p);
    const qs = p.toString();
    return qs === '' ? options.baseUrl : `${options.baseUrl}?${qs}`;
  };

  if (pagination.kind === 'offset') {
    const meta: PaginationMeta = {
      limit: pagination.limit,
      offset: pagination.offset,
      hasMore,
    };
    if (options.total !== undefined) meta.total = options.total;
    const links: PaginationLinks = {
      self: href((p) => {
        p.set('limit', String(pagination.limit));
        p.set('offset', String(pagination.offset));
        p.delete('cursor');
      }),
      first: href((p) => {
        p.set('limit', String(pagination.limit));
        p.set('offset', '0');
        p.delete('cursor');
      }),
    };
    if (hasMore) {
      links.next = href((p) => {
        p.set('limit', String(pagination.limit));
        p.set('offset', String(pagination.offset + pagination.limit));
        p.delete('cursor');
      });
    }
    if (pagination.offset > 0) {
      links.prev = href((p) => {
        p.set('limit', String(pagination.limit));
        p.set('offset', String(Math.max(0, pagination.offset - pagination.limit)));
        p.delete('cursor');
      });
    }
    if (options.total !== undefined && options.total > 0) {
      const lastOffset = Math.max(
        0,
        Math.floor((options.total - 1) / pagination.limit) * pagination.limit,
      );
      links.last = href((p) => {
        p.set('limit', String(pagination.limit));
        p.set('offset', String(lastOffset));
        p.delete('cursor');
      });
    }
    return { meta, links };
  }

  const nextCursor =
    options.nextCursorPayload === undefined
      ? undefined
      : encodeCursor(options.nextCursorPayload, options.cursorSecret);
  const prevCursor =
    options.prevCursorPayload === undefined
      ? undefined
      : encodeCursor(options.prevCursorPayload, options.cursorSecret);
  const meta: PaginationMeta = {
    limit: pagination.limit,
    cursor: pagination.cursor,
    nextCursor,
    prevCursor,
    hasMore,
  };
  const links: PaginationLinks = {
    self: href((p) => {
      p.set('limit', String(pagination.limit));
      if (pagination.cursor) p.set('cursor', pagination.cursor);
      else p.delete('cursor');
      p.delete('offset');
    }),
  };
  if (nextCursor !== undefined) {
    links.next = href((p) => {
      p.set('limit', String(pagination.limit));
      p.set('cursor', nextCursor);
      p.delete('offset');
    });
  }
  if (prevCursor !== undefined) {
    links.prev = href((p) => {
      p.set('limit', String(pagination.limit));
      p.set('cursor', prevCursor);
      p.delete('offset');
    });
  }
  return { meta, links };
}

/** Generates a random opaque token (for tests or non-JSON cursors). */
export function randomCursorToken(): string {
  return randomBytes(16).toString('base64url');
}
