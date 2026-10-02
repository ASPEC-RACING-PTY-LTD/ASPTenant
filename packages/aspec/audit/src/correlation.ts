import { BlockList, isIP } from 'node:net';
import type { ActorResolverResult, AuditContext } from './context.js';
import { AuditError } from './errors.js';
import { uuidv7 } from './ids.js';
import { cleanString } from './redact.js';

/**
 * Which proxies are trusted to set X-Forwarded-For:
 * - `false` (default): use the socket address only;
 * - `true`: trust every hop (only when the application is always behind a proxy that overwrites the header);
 * - a number: trust that many hops in front of the application;
 * - addresses, CIDR ranges or presets (`loopback`, `linklocal`, `uniquelocal`), as an array or comma-separated string;
 * - a function receiving the address and hop index.
 */
export type TrustProxy =
  | boolean
  | number
  | string
  | readonly string[]
  | ((address: string, hop: number) => boolean);

export interface CorrelationOptions<Req> {
  /** Incoming and outgoing request ID header. Default `x-request-id`. */
  requestIdHeader?: string;
  /** Incoming correlation ID header. Default `x-correlation-id`. */
  correlationIdHeader?: string;
  /** Accept a valid incoming request ID. Default true. */
  trustIncomingRequestId?: boolean;
  /** Pattern incoming IDs must match. Default `^[A-Za-z0-9._:/+=-]{1,128}$`. */
  requestIdPattern?: RegExp;
  /** Generates request IDs. Default UUID v7. */
  generateRequestId?: () => string;
  /** Use the trace ID of a valid W3C traceparent header when no request ID is sent. Default true. */
  useTraceparent?: boolean;
  /** Response header carrying the request ID, or false. Default `x-request-id`. */
  responseHeader?: string | false;
  trustProxy?: TrustProxy;
  /** Resolves the actor lazily, when an event is recorded. */
  resolveActor?: (req: Req) => ActorResolverResult | Promise<ActorResolverResult>;
  /** Resolves the tenant of the request. */
  resolveTenant?: (req: Req) => string | undefined;
}

export interface ResolvedCorrelation<Req> {
  requestIdHeader: string;
  correlationIdHeader: string;
  trustIncomingRequestId: boolean;
  requestIdPattern: RegExp;
  generateRequestId: () => string;
  useTraceparent: boolean;
  responseHeader: string | false;
  trust: (address: string, hop: number) => boolean;
  resolveActor?: (req: Req) => ActorResolverResult | Promise<ActorResolverResult>;
  resolveTenant?: (req: Req) => string | undefined;
}

const HEADER = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const DEFAULT_ID_PATTERN = /^[A-Za-z0-9._:/+=-]{1,128}$/;
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const PRESETS: Record<string, readonly string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

/** Removes the IPv4-mapped IPv6 prefix and surrounding whitespace. */
export function normaliseIp(address: string): string {
  const a = address.trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  return m?.[1] ?? a;
}

function compileTrust(trust: TrustProxy | undefined): (address: string, hop: number) => boolean {
  if (trust === undefined || trust === false) return () => false;
  if (trust === true) return () => true;
  if (typeof trust === 'function') return trust;
  if (typeof trust === 'number') {
    if (!Number.isInteger(trust) || trust < 0) {
      throw new AuditError(
        'AUDIT_INVALID_OPTIONS',
        'trustProxy hop count must be a non-negative integer',
      );
    }
    return (_a, hop) => hop < trust;
  }
  const entries = (typeof trust === 'string' ? trust.split(',') : [...trust])
    .map((s) => s.trim())
    .filter(Boolean);
  const list = new BlockList();
  for (const entry of entries.flatMap((e) => PRESETS[e] ?? [e])) {
    const [net, prefix] = entry.split('/');
    const ip = normaliseIp(net ?? '');
    const family = isIP(ip);
    if (family === 0) {
      throw new AuditError(
        'AUDIT_INVALID_OPTIONS',
        `trustProxy entry "${entry}" is not an IP or CIDR`,
      );
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(ip, type);
    else {
      const bits = Number(prefix);
      if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) {
        throw new AuditError(
          'AUDIT_INVALID_OPTIONS',
          `trustProxy entry "${entry}" has an invalid prefix`,
        );
      }
      list.addSubnet(ip, bits, type);
    }
  }
  return (address) => {
    const ip = normaliseIp(address);
    const family = isIP(ip);
    if (family === 0) return false;
    return list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  };
}

export function resolveCorrelationOptions<Req>(
  options: CorrelationOptions<Req> = {},
): ResolvedCorrelation<Req> {
  const requestIdHeader = (options.requestIdHeader ?? 'x-request-id').toLowerCase();
  const correlationIdHeader = (options.correlationIdHeader ?? 'x-correlation-id').toLowerCase();
  for (const [name, value] of [
    ['requestIdHeader', requestIdHeader],
    ['correlationIdHeader', correlationIdHeader],
  ] as const) {
    if (!HEADER.test(value)) {
      throw new AuditError('AUDIT_INVALID_OPTIONS', `${name} is not a valid header name`);
    }
  }
  const responseHeader =
    options.responseHeader === false ? false : (options.responseHeader ?? requestIdHeader);
  if (responseHeader !== false && !HEADER.test(responseHeader.toLowerCase())) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'responseHeader is not a valid header name');
  }
  const out: ResolvedCorrelation<Req> = {
    requestIdHeader,
    correlationIdHeader,
    trustIncomingRequestId: options.trustIncomingRequestId ?? true,
    requestIdPattern: options.requestIdPattern ?? DEFAULT_ID_PATTERN,
    generateRequestId: options.generateRequestId ?? uuidv7,
    useTraceparent: options.useTraceparent ?? true,
    responseHeader,
    trust: compileTrust(options.trustProxy),
  };
  if (options.resolveActor) out.resolveActor = options.resolveActor;
  if (options.resolveTenant) out.resolveTenant = options.resolveTenant;
  return out;
}

/** Parses a W3C traceparent header; returns the trace ID when valid. */
export function parseTraceparent(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = TRACEPARENT.exec(value.trim().toLowerCase());
  if (!m) return undefined;
  const [, version, traceId, parentId] = m;
  if (version === 'ff' || /^0+$/.test(traceId ?? '') || /^0+$/.test(parentId ?? '')) {
    return undefined;
  }
  return traceId;
}

/**
 * Determines the client IP from the socket address and X-Forwarded-For, walking from the
 * nearest hop outwards and stopping at the first untrusted address.
 */
export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | undefined,
  trust: (address: string, hop: number) => boolean,
): string | undefined {
  if (!remoteAddress) return undefined;
  const chain = [normaliseIp(remoteAddress)];
  if (forwardedFor) {
    const hops = forwardedFor
      .split(',')
      .map((s) => normaliseIp(s))
      .filter(Boolean)
      .reverse();
    chain.push(...hops);
  }
  for (let i = 0; i < chain.length - 1; i++) {
    const addr = chain[i] as string;
    if (!trust(addr, i)) return addr;
    const next = chain[i + 1] as string;
    if (isIP(next) === 0) return addr;
  }
  return chain[chain.length - 1];
}

export type HeaderGetter = (name: string) => string | undefined;

/** Builds the audit context of one request from its headers and socket address. */
export function buildAuditContext<Req>(
  req: Req,
  getHeader: HeaderGetter,
  remoteAddress: string | undefined,
  options: ResolvedCorrelation<Req>,
): AuditContext {
  const valid = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t && options.requestIdPattern.test(t) ? t : undefined;
  };
  const traceId = options.useTraceparent ? parseTraceparent(getHeader('traceparent')) : undefined;
  const incoming = options.trustIncomingRequestId
    ? valid(getHeader(options.requestIdHeader))
    : undefined;
  const requestId = incoming ?? traceId ?? options.generateRequestId();
  const correlationId = valid(getHeader(options.correlationIdHeader)) ?? traceId ?? requestId;
  const ctx: AuditContext = { requestId, correlationId };
  if (traceId) ctx.traceId = traceId;
  const ip = resolveClientIp(remoteAddress, getHeader('x-forwarded-for'), options.trust);
  if (ip) ctx.ip = ip;
  const ua = getHeader('user-agent');
  if (ua) ctx.userAgent = cleanString(ua).slice(0, 512);
  const tenant = options.resolveTenant?.(req);
  if (tenant) ctx.tenantId = tenant;
  const resolver = options.resolveActor;
  if (resolver) ctx.resolveActor = () => resolver(req);
  return ctx;
}
