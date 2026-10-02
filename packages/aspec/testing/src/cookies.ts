import type { Clock } from './ports.js';

export interface StoredCookie {
  name: string;
  value: string;
  path: string;
  domain: string | undefined;
  /** Epoch ms, or undefined for session cookies. */
  expiresAt: number | undefined;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | undefined;
}

const systemClock: Clock = { now: () => Date.now() };
const MAX_COOKIES = 500;

function defaultPath(requestPath: string): string {
  const idx = requestPath.lastIndexOf('/');
  return idx <= 0 ? '/' : requestPath.slice(0, idx);
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

/** Parses one Set-Cookie header value. Returns undefined for malformed input. */
export function parseSetCookie(
  header: string,
  requestPath = '/',
  clock: Clock = systemClock,
): StoredCookie | undefined {
  const [pair, ...attrs] = header.split(';');
  if (!pair) return undefined;
  const eq = pair.indexOf('=');
  if (eq <= 0) return undefined;
  const name = pair.slice(0, eq).trim();
  let value = pair.slice(eq + 1).trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
  if (!name) return undefined;
  const cookie: StoredCookie = {
    name,
    value,
    path: defaultPath(requestPath),
    domain: undefined,
    expiresAt: undefined,
    httpOnly: false,
    secure: false,
    sameSite: undefined,
  };
  let maxAgeSeen = false;
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : attr.slice(i + 1).trim();
    if (key === 'path' && val.startsWith('/')) cookie.path = val;
    else if (key === 'domain' && val) cookie.domain = val.replace(/^\./, '').toLowerCase();
    else if (key === 'max-age' && /^-?\d+$/.test(val)) {
      maxAgeSeen = true;
      cookie.expiresAt = clock.now() + Number(val) * 1000;
    } else if (key === 'expires' && !maxAgeSeen) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) cookie.expiresAt = t;
    } else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') cookie.sameSite = val;
  }
  return cookie;
}

/**
 * Minimal RFC 6265 cookie jar for a single test target. Honours Path, Max-Age and Expires.
 * Secure cookies are sent over plain HTTP because test traffic stays on loopback or in memory.
 */
export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();
  private readonly clock: Clock;

  constructor(options: { clock?: Clock } = {}) {
    this.clock = options.clock ?? systemClock;
  }

  private key(name: string, path: string): string {
    return `${name}\u0000${path}`;
  }

  /** Stores cookies from Set-Cookie header values received for `requestPath`. */
  storeFromHeaders(setCookie: readonly string[], requestPath = '/'): void {
    for (const header of setCookie) {
      const cookie = parseSetCookie(header, requestPath, this.clock);
      if (cookie) this.store(cookie);
    }
  }

  private store(cookie: StoredCookie): void {
    const key = this.key(cookie.name, cookie.path);
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= this.clock.now()) {
      this.cookies.delete(key);
      return;
    }
    this.cookies.delete(key);
    this.cookies.set(key, cookie);
    if (this.cookies.size > MAX_COOKIES) {
      const oldest = this.cookies.keys().next().value;
      if (oldest !== undefined) this.cookies.delete(oldest);
    }
  }

  /** Sets a cookie directly (value is used as-is on the wire). */
  set(name: string, value: string, options: { path?: string; maxAgeSeconds?: number } = {}): void {
    this.store({
      name,
      value,
      path: options.path ?? '/',
      domain: undefined,
      expiresAt:
        options.maxAgeSeconds === undefined
          ? undefined
          : this.clock.now() + options.maxAgeSeconds * 1000,
      httpOnly: false,
      secure: false,
      sameSite: undefined,
    });
  }

  /** Stores a full Set-Cookie header value (for example from createSessionCookie). */
  setFromHeader(setCookie: string, requestPath = '/'): void {
    this.storeFromHeaders([setCookie], requestPath);
  }

  /** The most specific live cookie with this name (optionally for a request path). */
  get(name: string, requestPath = '/'): StoredCookie | undefined {
    return this.matching(requestPath).find((c) => c.name === name);
  }

  delete(name: string): void {
    for (const [key, c] of this.cookies) if (c.name === name) this.cookies.delete(key);
  }

  clear(): void {
    this.cookies.clear();
  }

  all(): StoredCookie[] {
    this.sweep();
    return [...this.cookies.values()];
  }

  /** Cookie request header for `requestPath`, or undefined when no cookie applies. */
  header(requestPath = '/'): string | undefined {
    const list = this.matching(requestPath);
    return list.length === 0 ? undefined : list.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  private sweep(): void {
    const now = this.clock.now();
    for (const [key, c] of this.cookies)
      if (c.expiresAt !== undefined && c.expiresAt <= now) this.cookies.delete(key);
  }

  private matching(requestPath: string): StoredCookie[] {
    this.sweep();
    return [...this.cookies.values()]
      .filter((c) => pathMatches(c.path, requestPath))
      .sort((a, b) => b.path.length - a.path.length);
  }
}
