import { configError } from './errors.js';
import { IpSet, normalizeIp } from './ip.js';

/**
 * Which proxies are trusted to report the client address.
 * - `false` (default): ignore forwarding headers, use the socket address.
 * - number: trust exactly that many hops in front of the application.
 * - string or string[]: trusted proxy IPs, CIDR ranges, or the presets
 *   "loopback", "linklocal", "uniquelocal" and "private".
 * - function: custom predicate receiving the hop address and its distance (0 = socket peer).
 * `true` (trust every hop) is accepted but insecure unless every request passes a proxy
 * that overwrites the header.
 */
export type TrustProxy =
  | boolean
  | number
  | string
  | readonly string[]
  | ((address: string, hop: number) => boolean);

export type ProxyHeader = 'x-forwarded-for' | 'forwarded';

export interface ClientIpOptions {
  trustProxy?: TrustProxy;
  /** Header read from trusted hops. Default "x-forwarded-for". */
  proxyHeader?: ProxyHeader;
}

export type HeaderReader = (name: string) => string | undefined;

export type ClientIpResolver = (
  remoteAddress: string | undefined,
  header: HeaderReader,
) => string | undefined;

const MAX_HOPS = 32;

function compileTrust(trust: TrustProxy | undefined): (address: string, hop: number) => boolean {
  if (trust === undefined || trust === false) return () => false;
  if (trust === true) return () => true;
  if (typeof trust === 'number') {
    if (!Number.isInteger(trust) || trust < 0 || trust > MAX_HOPS) {
      throw configError('trustProxy', `hop count must be an integer between 0 and ${MAX_HOPS}`);
    }
    return (_address, hop) => hop < trust;
  }
  if (typeof trust === 'function') return trust;
  const entries = typeof trust === 'string' ? trust.split(',').map((s) => s.trim()) : trust;
  const set = new IpSet(
    entries.filter((e) => e.length > 0),
    'trustProxy',
  );
  return (address) => set.has(address);
}

/** Splits a header list on commas outside quoted strings. */
function splitList(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === '"' && value[i - 1] !== '\\') quoted = !quoted;
    if (ch === ',' && !quoted) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}

/** Extracts the `for=` node of each RFC 7239 Forwarded element. */
export function parseForwarded(value: string): string[] {
  return splitList(value).map((element) => {
    for (const pair of element.split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      if (pair.slice(0, eq).trim().toLowerCase() !== 'for') continue;
      let node = pair.slice(eq + 1).trim();
      if (node.startsWith('"') && node.endsWith('"') && node.length >= 2) node = node.slice(1, -1);
      return node;
    }
    return '';
  });
}

export function parseXForwardedFor(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Creates a resolver that walks forwarding headers from the closest hop outwards and
 * returns the first address that is not a trusted proxy. Addresses supplied by the client
 * (left of the first untrusted hop) are never used, so spoofed headers have no effect.
 */
export function createClientIpResolver(options: ClientIpOptions = {}): ClientIpResolver {
  const trusted = compileTrust(options.trustProxy);
  const headerName = options.proxyHeader ?? 'x-forwarded-for';
  if (headerName !== 'x-forwarded-for' && headerName !== 'forwarded') {
    throw configError('proxyHeader', 'must be "x-forwarded-for" or "forwarded"');
  }
  const disabled = options.trustProxy === undefined || options.trustProxy === false;
  return (remoteAddress, header) => {
    const socket = normalizeIp(remoteAddress);
    if (disabled || socket === undefined || !trusted(socket, 0)) return socket;
    const raw = header(headerName);
    if (!raw) return socket;
    const listed = headerName === 'forwarded' ? parseForwarded(raw) : parseXForwardedFor(raw);
    let current = socket;
    for (let i = listed.length - 1, hop = 1; i >= 0 && hop <= MAX_HOPS; i--, hop++) {
      const next = normalizeIp(listed[i]);
      // An unparseable entry ("unknown", obfuscated node) ends the chain at the last known hop.
      if (next === undefined) return current;
      current = next;
      if (!trusted(current, hop)) return current;
    }
    return current;
  };
}
